import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
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

function logChannel(event: string, level: 'log' | 'error', fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, service: 'alerting-service', ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  };
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
    logChannel('alerting.channel.no_target', 'log', {
      correlationId,
      memberId,
      channel,
      reason: resolved.reason,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'NoTargetRegistered', channel);
    return;
  }

  const channelUpper = channel.toUpperCase();
  const idempotencyKey = `${dispatchId}#${toneSequence}#${memberId}#${channelUpper}`;
  const sentAt = Date.now();

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          sk: `RECEIPT#${memberId}#${channelUpper}#${toneSequence}`,
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
      logChannel('alerting.channel.duplicate_skipped', 'log', { correlationId, memberId, channel });
      emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped', channel);
      return;
    }
    logChannel('alerting.channel.receipt_write_failed', 'error', {
      correlationId,
      memberId,
      channel,
      ...errorFields(error),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
    throw error;
  }

  try {
    await sendViaHttpProvider(channel, resolved.target, message, env);
  } catch (error) {
    logChannel('alerting.channel.send_failed', 'error', {
      correlationId,
      memberId,
      channel,
      ...errorFields(error),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
}

export function createChannelWorkerHandler(
  channel: ChannelName,
): (event: SQSEvent) => Promise<void> {
  return async (event: SQSEvent): Promise<void> => {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env);

    for (const record of event.Records) {
      let envelope: ReturnType<typeof parseChannelEnvelope>;
      try {
        envelope = parseChannelEnvelope(record.body, channel);
      } catch (error) {
        logChannel('alerting.channel.malformed_event', 'error', {
          correlationId: record.messageId,
          channel,
          ...errorFields(error),
        });
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
      const snapshot = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${envelope.memberId}` },
        }),
      );
      const contactChannels = snapshot.Item?.contactChannels as
        ContactChannelSnapshot[] | undefined;

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
  };
}
