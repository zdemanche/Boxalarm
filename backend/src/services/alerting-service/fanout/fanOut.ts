import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createEscalationSchedule } from '../escalation/scheduleEscalation.js';
import { scheduleDepartmentToneLadder } from '../escalation/toneLadder.js';

/**
 * Roster rows and escalation scheduling for the stream fan-out (fanout/handler.ts), which is the
 * single producer of tone-1 pages. The synchronous `runFanOut` that used to live here pre-wrote
 * tone-1 receipts with `sentAt` and never published - the stream fan-out then skipped every
 * member as a duplicate (design review C1). It is gone; do not reintroduce a second producer.
 */
const TONE_SEQUENCE_ONE = 1;

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

/**
 * Seeds the member's roster row for this dispatch. Every field is `if_not_exists`: a member can
 * answer (responses/repository.ts) before the fan-out gets here - the pages go out first - and
 * that answer must survive, while the row still gets the currentChannelTier / escalationLevel
 * the escalation handler requires (review MAJOR-1: an answer-first row had neither, and the
 * member's 75 s escalation failed its parse and paged on-call).
 */
async function ensureRosterEntry(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  quals: readonly string[],
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: `ROSTER#${memberId}` },
      UpdateExpression: ROSTER_SEED_EXPRESSION,
      ExpressionAttributeValues: rosterSeedValues(memberId, quals),
    }),
  );
}

/** The roster row's required fields, each seeded only where absent. */
const ROSTER_SEED_EXPRESSION =
  'SET entityType = :rosterEntityType, memberId = :rosterMemberId, quals = if_not_exists(quals, :rosterQuals), ackStatus = if_not_exists(ackStatus, :rosterNone), currentChannelTier = if_not_exists(currentChannelTier, :rosterPrimary), escalationLevel = if_not_exists(escalationLevel, :rosterZero)';

function rosterSeedValues(memberId: string, quals: readonly string[]): Record<string, unknown> {
  return {
    ':rosterEntityType': 'DISPATCH_ROSTER_ENTRY',
    ':rosterMemberId': memberId,
    ':rosterQuals': quals,
    ':rosterNone': 'NONE',
    ':rosterPrimary': 'primary',
    ':rosterZero': 0,
  };
}

export async function scheduleRealtimeFanOutEscalation(
  ddb: DynamoDBDocumentClient,
  scheduler: SchedulerClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  members: ReadonlyArray<{ readonly memberId: string; readonly quals: readonly string[] }>,
): Promise<void> {
  for (const member of members) {
    await ensureRosterEntry(ddb, tableName, deptId, dispatchId, member.memberId, member.quals);
    await createEscalationSchedule(
      scheduler,
      { deptId, dispatchId, memberId: member.memberId, toneSequence: TONE_SEQUENCE_ONE },
      ddb,
      tableName,
    );
  }
  if (members.length > 0) {
    await scheduleDepartmentToneLadder(scheduler, ddb, tableName, deptId, dispatchId);
  }
}
