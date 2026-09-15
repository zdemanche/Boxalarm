import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  parseChannelEnvelope,
  resolveChannelTarget,
  type ChannelName,
  type ContactChannelSnapshot,
} from './channelEnvelope.js';
import { sendViaHttpProvider } from './httpProviderAdapter.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingChannel';

const CHANNEL_TIER: Record<ChannelName, 'primary' | 'escalation'> = {
  push: 'primary',
  sms: 'primary',
  voice: 'escalation',
};

export interface DeliverChannelMessageParams {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly toneSequence: number;
  readonly contactChannels: readonly ContactChannelSnapshot[] | undefined;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function deliverChannelMessage(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
): Promise<void> {
  const { deptId, dispatchId, memberId, channel, toneSequence, contactChannels, message, env } =
    params;
  const correlationId = dispatchId;
  const resolved = resolveChannelTarget(channel, contactChannels);
  if (resolved.skipped) {
    logInfo('alerting.channel.no_target', { correlationId, memberId, channel, reason: resolved.reason });
    emitOutcomeMetric(METRIC_NAMESPACE, 'NoTargetRegistered', channel);
    return;
  }

  const channelUpper = channel.toUpperCase();
  const idempotencyKey = `${dispatchId}#${toneSequence}#${memberId}#${channelUpper}`;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const sk = `RECEIPT#${memberId}#${channelUpper}#${toneSequence}`;
  const sentAt = Math.floor(Date.now() / 1000);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          entityType: 'DELIVERY_RECEIPT',
          dispatchId,
          memberId,
          deptId,
          channel: channelUpper,
          channelTier: CHANNEL_TIER[channel],
          toneSequence,
          sentAt,
          deliveredAt: null,
          openedAt: null,
          failureReason: null,
          idempotencyKey,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `RECEIPT#${sentAt}#${dispatchId}`,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const retried = await reattemptClaimedFailure(ddb, tableName, pk, sk, sentAt);
      if (!retried) {
        logInfo('alerting.channel.duplicate_skipped', { correlationId, memberId, channel });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped', channel);
        return;
      }
    } else {
      logError('alerting.channel.receipt_write_failed', error, { correlationId, memberId, channel });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
      throw error;
    }
  }

  try {
    await sendViaHttpProvider(channel, resolved.target, message, env);
  } catch (error) {
    logError('alerting.channel.send_failed', error, { correlationId, memberId, channel });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
    await recordClaimedFailure(ddb, tableName, pk, sk, error);
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
}

async function reattemptClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  sentAt: number,
): Promise<boolean> {
  const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
  const item = existing.Item;
  const claimedButFailed = Boolean(item) && item?.failureReason != null && item?.deliveredAt == null;
  if (!claimedButFailed) {
    return false;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: 'SET sentAt = :sentAt REMOVE failureReason',
      ConditionExpression: 'attribute_exists(idempotencyKey) AND attribute_not_exists(deliveredAt)',
      ExpressionAttributeValues: { ':sentAt': sentAt },
    }),
  );
  return true;
}

async function recordClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  error: unknown,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET failureReason = :reason',
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: {
          ':reason': error instanceof Error ? error.message : String(error),
        },
      }),
    );
  } catch (updateError) {
    logError('alerting.channel.failure_reason_write_failed', updateError, { pk, sk });
  }
}

export function createChannelWorkerHandler(
  channel: ChannelName,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env);

    async function processRecord(record: SQSEvent['Records'][number]): Promise<void> {
      let envelope: ReturnType<typeof parseChannelEnvelope>;
      try {
        envelope = parseChannelEnvelope(record.body, channel);
      } catch (error) {
        logError('alerting.channel.malformed_event', error, {
          correlationId: record.messageId,
          channel,
        });
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
      let contactChannels: ContactChannelSnapshot[] | undefined;
      try {
        const snapshot = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${envelope.memberId}` },
          }),
        );
        contactChannels = snapshot.Item?.contactChannels as ContactChannelSnapshot[] | undefined;
      } catch (error) {
        logError('alerting.channel.eligibility_read_failed', error, {
          correlationId: envelope.dispatchId,
          memberId: envelope.memberId,
          channel,
        });
        throw error;
      }

      await deliverChannelMessage(ddb, tableName, {
        deptId,
        dispatchId: envelope.dispatchId,
        memberId: envelope.memberId,
        channel,
        toneSequence: envelope.toneSequence,
        contactChannels,
        message: `${envelope.incidentType} — ${envelope.address}`,
        env: process.env,
      });
    }

    const results = await Promise.allSettled(event.Records.map(processRecord));
    const batchItemFailures = results
      .map((result, index) =>
        result.status === 'rejected' ? { itemIdentifier: event.Records[index]?.messageId ?? '' } : null,
      )
      .filter((failure): failure is { itemIdentifier: string } => failure !== null);

    return { batchItemFailures };
  };
}
