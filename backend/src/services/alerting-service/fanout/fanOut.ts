import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { queryEligibleMembers } from '../eligibility/selector.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { createEscalationSchedule } from '../escalation/scheduleEscalation.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const TONE_SEQUENCE_ONE = 1;

export type PrimaryChannel = 'PUSH' | 'SMS';

export type RosterAckStatus = 'NONE' | 'RESPONDING' | 'NOT_RESPONDING' | 'DIRECT_TO_SCENE';

export type RosterEntryItem = Record<'pk' | 'sk', string> & {
  readonly entityType: 'DISPATCH_ROSTER_ENTRY';
  readonly memberId: string;
  readonly ackStatus: RosterAckStatus;
  readonly currentChannelTier: 'primary' | 'escalation';
};

export function parseRosterItem(
  item: Record<string, unknown> | undefined,
): RosterEntryItem | undefined {
  if (!item) {
    return undefined;
  }
  const { pk, sk, entityType, memberId, ackStatus, currentChannelTier } = item;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    entityType !== 'DISPATCH_ROSTER_ENTRY' ||
    typeof memberId !== 'string' ||
    (ackStatus !== 'NONE' &&
      ackStatus !== 'RESPONDING' &&
      ackStatus !== 'NOT_RESPONDING' &&
      ackStatus !== 'DIRECT_TO_SCENE') ||
    (currentChannelTier !== 'primary' && currentChannelTier !== 'escalation')
  ) {
    throw new Error('DISPATCH_ROSTER_ENTRY item failed shape validation');
  }
  return { pk, sk, entityType, memberId, ackStatus, currentChannelTier };
}

function buildReceiptItem(
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  channel: PrimaryChannel,
  dispatchedAt: number,
): Record<string, unknown> {
  const idempotencyKey = `${dispatchId}#${TONE_SEQUENCE_ONE}#${memberId}#${channel}`;
  return {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `RECEIPT#${memberId}#${channel}#${TONE_SEQUENCE_ONE}`,
    entityType: 'DELIVERY_RECEIPT',
    dispatchId,
    memberId,
    deptId,
    channel,
    channelTier: 'primary',
    toneSequence: TONE_SEQUENCE_ONE,
    sentAt: dispatchedAt,
    idempotencyKey,
  };
}

function buildRosterItem(
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  quals: readonly string[],
): Record<string, unknown> {
  return {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `ROSTER#${memberId}`,
    entityType: 'DISPATCH_ROSTER_ENTRY',
    memberId,
    quals,
    ackStatus: 'NONE',
    currentChannelTier: 'primary',
    escalationLevel: 0,
  };
}

async function fanOutOneMember(
  ddb: DynamoDBDocumentClient,
  scheduler: SchedulerClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatchedAt: number,
  memberId: string,
  quals: readonly string[],
): Promise<void> {
  const pushItem = buildReceiptItem(deptId, dispatchId, memberId, 'PUSH', dispatchedAt);
  const smsItem = buildReceiptItem(deptId, dispatchId, memberId, 'SMS', dispatchedAt);
  const rosterItem = buildRosterItem(deptId, dispatchId, memberId, quals);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: pushItem,
              ConditionExpression: 'attribute_not_exists(idempotencyKey)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: smsItem,
              ConditionExpression: 'attribute_not_exists(idempotencyKey)',
            },
          },
          { Put: { TableName: tableName, Item: rosterItem } },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      logInfo('alerting.fanout.duplicate', { deptId, dispatchId, memberId });
      return;
    }
    logError('alerting.fanout.write_failed', error, { deptId, dispatchId, memberId });
    throw error;
  }

  try {
    await createEscalationSchedule(
      scheduler,
      { deptId, dispatchId, memberId, toneSequence: TONE_SEQUENCE_ONE },
      ddb,
      tableName,
    );
  } catch (error) {
    logError('alerting.fanout.schedule_failed', error, { deptId, dispatchId, memberId });
  }
}

export async function runFanOut(
  ddb: DynamoDBDocumentClient,
  scheduler: SchedulerClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  dispatchedAt: number,
): Promise<void> {
  let eligibleMembers;
  try {
    eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
  } catch (error) {
    logError('alerting.fanout.eligibility_query_failed', error, { deptId, dispatchId });
    throw error;
  }

  for (const member of eligibleMembers) {
    await fanOutOneMember(
      ddb,
      scheduler,
      tableName,
      deptId,
      dispatchId,
      dispatchedAt,
      member.memberId,
      member.quals,
    );
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'FanOutCompleted');
  logInfo('alerting.fanout.completed', {
    deptId,
    dispatchId,
    eligibleMemberCount: eligibleMembers.length,
  });
}
