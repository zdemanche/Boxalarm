import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { randomUUID } from 'node:crypto';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { queryEligibleMembers, type EligibilitySnapshotItem } from '../eligibility/selector.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { queryRoster } from '../roster/repository.js';
import { createSnsClient, readFanOutTopicConfig } from '../fanout/snsClient.js';
import {
  deriveFanOutKey,
  deriveMessageDeduplicationId,
  type FanOutChannel,
} from '../fanout/idempotencyKey.js';
import { createEscalationSchedule, getSchedulerClient } from './scheduleEscalation.js';
import { officerManualPromptAdapter } from './mutualAidPort.js';
import {
  isPredicateMet,
  readDepartmentToneConfig,
  MUTUAL_AID_AFTER_TONE,
  TONE_SEQUENCE_THREE,
} from './toneLadder.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const CHANNEL_TIER = 'escalation';
const VOICE_ESCALATION_DELAY_SECONDS = 75;
const FAN_OUT_CHANNELS: readonly FanOutChannel[] = ['push', 'sms'];

export interface ToneEvaluatorPayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly toneSequence: number;
}

export type ToneOutcome =
  | 'FIRED'
  | 'SKIPPED_PREDICATE_MET'
  | 'SKIPPED_ALREADY_FIRED'
  | 'SKIPPED_MANUALLY_HALTED'
  | 'SKIPPED_COMPLETED'
  | 'SKIPPED_NOT_FOUND';

function isToneEvaluatorPayload(value: unknown): value is ToneEvaluatorPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    candidate.deptId.length > 0 &&
    typeof candidate.dispatchId === 'string' &&
    candidate.dispatchId.length > 0 &&
    typeof candidate.toneSequence === 'number'
  );
}

interface DispatchMetadata {
  readonly toneLadderStatus: string;
  readonly incidentType: string | undefined;
  readonly address: string | undefined;
  readonly crossStreets: string | undefined;
  readonly narrative: string | undefined;
}

async function publishToneChannel(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  memberId: string,
  channel: FanOutChannel,
  toneSequence: number,
): Promise<void> {
  const { sk, idempotencyKey } = deriveFanOutKey({ dispatchId, toneSequence, memberId, channel });
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
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
          channel,
          channelTier: CHANNEL_TIER,
          toneSequence,
          idempotencyKey,
          gsi1pk: `MEMBER#${memberId}`,
          gsi1sk: `RECEIPT#${Math.floor(Date.now() / 1000)}#${dispatchId}`,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logInfo('alerting.toneLadder.duplicateReceipt', {
        deptId,
        dispatchId,
        memberId,
        channel,
        toneSequence,
      });
      return;
    }
    logError('alerting.toneLadder.receiptWriteFailed', error, {
      deptId,
      dispatchId,
      memberId,
      channel,
    });
    throw error;
  }

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify({
        eventId: randomUUID(),
        eventTime: new Date().toISOString(),
        eventType: 'alerting.dispatch.normalized',
        source: 'alerting-service',
        correlationId: dispatchId,
        schemaVersion: '1.0',
        payload: {
          dispatchId,
          memberId,
          channel,
          channelTier: CHANNEL_TIER,
          toneSequence,
          incidentType: dispatch.incidentType,
          address: dispatch.address,
          crossStreets: dispatch.crossStreets,
          narrative: dispatch.narrative,
        },
      }),
      MessageGroupId: dispatchId,
      MessageDeduplicationId: deriveMessageDeduplicationId({
        dispatchId,
        toneSequence,
        memberId,
        channel,
      }),
      MessageAttributes: {
        channel: { DataType: 'String', StringValue: channel },
        channelTier: { DataType: 'String', StringValue: CHANNEL_TIER },
        toneSequence: { DataType: 'Number', StringValue: String(toneSequence) },
      },
    }),
  );
}

async function fireTone(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: Parameters<typeof createEscalationSchedule>[0],
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatch: DispatchMetadata,
  toneSequence: number,
  members: readonly EligibilitySnapshotItem[],
): Promise<void> {
  for (const member of members) {
    for (const channel of FAN_OUT_CHANNELS) {
      if (channel === 'push' && resolvePushTarget(member.contactChannels).skipped) {
        continue;
      }
      if (channel === 'sms' && resolveSmsTarget(member.contactChannels).skipped) {
        continue;
      }
      await publishToneChannel(
        ddb,
        sns,
        tableName,
        topicArn,
        deptId,
        dispatchId,
        dispatch,
        member.memberId,
        channel,
        toneSequence,
      );
    }
    try {
      await createEscalationSchedule(
        scheduler,
        {
          deptId,
          dispatchId,
          memberId: member.memberId,
          toneSequence,
          delaySeconds: VOICE_ESCALATION_DELAY_SECONDS,
        },
        ddb,
        tableName,
      );
    } catch (error) {
      logError('alerting.toneLadder.voiceScheduleFailed', error, {
        deptId,
        dispatchId,
        memberId: member.memberId,
        toneSequence,
      });
    }
  }
}

export const handler = async (payload: unknown): Promise<{ outcome: ToneOutcome }> => {
  if (!isToneEvaluatorPayload(payload)) {
    const error = new Error('tone evaluator payload failed shape validation');
    logError('alerting.toneLadder.malformedPayload', error, {});
    throw error;
  }
  const { dispatchId, toneSequence } = payload;
  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const correlationId = `${dispatchId}#${toneSequence}`;
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const scheduler = getSchedulerClient();
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  const metadataResult = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
  );
  const metadataItem = metadataResult.Item;
  if (!metadataItem) {
    logInfo('alerting.toneLadder.dispatchNotFound', { correlationId });
    return { outcome: 'SKIPPED_NOT_FOUND' };
  }
  const dispatch: DispatchMetadata = {
    toneLadderStatus:
      typeof metadataItem.toneLadderStatus === 'string' ? metadataItem.toneLadderStatus : 'ACTIVE',
    incidentType:
      typeof metadataItem.incidentType === 'string' ? metadataItem.incidentType : undefined,
    address: typeof metadataItem.address === 'string' ? metadataItem.address : undefined,
    crossStreets:
      typeof metadataItem.crossStreets === 'string' ? metadataItem.crossStreets : undefined,
    narrative: typeof metadataItem.narrative === 'string' ? metadataItem.narrative : undefined,
  };

  if (dispatch.toneLadderStatus === 'HALTED_MANUAL') {
    logInfo('alerting.toneLadder.skippedHalted', { correlationId });
    return { outcome: 'SKIPPED_MANUALLY_HALTED' };
  }
  if (dispatch.toneLadderStatus === 'COMPLETED') {
    logInfo('alerting.toneLadder.skippedCompleted', { correlationId });
    return { outcome: 'SKIPPED_COMPLETED' };
  }

  const roster = await queryRoster(ddb, tableName, deptId, dispatchId);
  const toneConfig = await readDepartmentToneConfig(ddb, tableName, deptId);
  const predicateMet = isPredicateMet(roster, toneConfig);
  const outcome: ToneOutcome = predicateMet ? 'SKIPPED_PREDICATE_MET' : 'FIRED';
  const evaluatedAt = Math.floor(Date.now() / 1000);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `TONE#${toneSequence}`,
                entityType: 'TONE_EVENT_GUARD',
                dispatchId,
                toneSequence,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `TONE#${toneSequence}#${evaluatedAt}`,
                entityType: 'TONE_EVENT',
                dispatchId,
                deptId,
                toneSequence,
                evaluatedAt,
                outcome,
                eligibleMemberCount: roster.length,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      logInfo('alerting.toneLadder.alreadyEvaluated', { correlationId });
      return { outcome: 'SKIPPED_ALREADY_FIRED' };
    }
    logError('alerting.toneLadder.guardWriteFailed', error, { correlationId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneEvaluationFailed');
    throw error;
  }

  if (predicateMet) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'ToneSkippedPredicateMet');
    logInfo('alerting.toneLadder.predicateMet', { correlationId });
    return { outcome };
  }

  const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  await fireTone(
    ddb,
    sns,
    scheduler,
    tableName,
    topicArn,
    deptId,
    dispatchId,
    dispatch,
    toneSequence,
    eligibleMembers,
  );

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk: 'METADATA' },
      UpdateExpression: 'SET currentToneSequence = :tone, toneLadderStatus = :status',
      ExpressionAttributeValues: {
        ':tone': toneSequence,
        ':status': toneSequence >= MUTUAL_AID_AFTER_TONE ? 'COMPLETED' : 'ACTIVE',
      },
    }),
  );

  if (toneSequence === TONE_SEQUENCE_THREE) {
    try {
      await officerManualPromptAdapter.requestMutualAid({
        ddb,
        sns,
        tableName,
        topicArn,
        deptId,
        dispatchId,
        reason: 'TONE_3_PREDICATE_UNMET',
      });
    } catch (error) {
      logError('alerting.toneLadder.mutualAidFailed', error, { correlationId });
    }
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'ToneFired');
  logInfo('alerting.toneLadder.fired', {
    correlationId,
    toneSequence,
    eligibleMemberCount: eligibleMembers.length,
  });
  return { outcome };
};
