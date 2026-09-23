import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { buildAttendanceKeys, type ActivityType } from '../attendance/handler.js';
import { buildLosapEntryItem } from '../losap/repository.js';
import { computeLosapPoints } from '../losap/rules.js';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import { mapWithConcurrency } from './coverageRepository.js';

/**
 * Epoch-unit convention (see PR #150 review round, finding #6): DUTY_SHIFT.startAt/endAt, and
 * the `now`/`asOf` values threaded through this module, are epoch MILLISECONDS — matching every
 * other file in this directory (coverageRepository.ts, claimShiftPosition.ts, shiftSwap.ts are
 * all Date.now()-based) and the real-DynamoDB-backed coverageRepository.test.ts.
 * ATTENDANCE_RECORD.occurredAt is a separate, pre-existing convention in epoch SECONDS (see
 * attendance/handler.ts's `occurredAt * 1000` conversion to build a Date) — this module converts
 * at that domain boundary via `occurredAtSeconds` below. Do not mix the two without an explicit
 * conversion, and do not reintroduce a `/1000`-style shift-domain calculation here.
 */

/** Shift-sourced attendance only uses these two activity types (subset of ActivityType). */
export type ShiftActivityType = Extract<ActivityType, 'STANDBY' | 'WORK_DETAIL'>;

const SHIFT_ACTIVITY_TYPES = [
  'STANDBY',
  'WORK_DETAIL',
] as const satisfies readonly ShiftActivityType[];

const CLAIM_CHECK_CONCURRENCY = 10;

// DynamoDB TransactWriteItems supports at most 100 items. Each claimed position contributes up
// to 3 items (ATTENDANCE_RECORD Put, optional LOSAP_POINT_ENTRY Put, OUTBOX_ENTRY Put) plus one
// shift-completion Update, so 33 positions is the safe ceiling regardless of whether the LOSAP
// calculator awards points (3 * 33 + 1 = 100). shiftAssembly.ts allows up to 99 claimed positions
// on a single shift, which would exceed this — surface a clear domain outcome instead of letting
// DynamoDB reject an oversized transaction with an opaque ValidationException.
const MAX_CLAIMED_POSITIONS_PER_TRANSACTION = 33;

export interface LosapPointsCalculator {
  compute(input: {
    readonly activityType: ShiftActivityType;
    readonly hours: number;
    readonly deptId: VerifiedDeptId;
    readonly memberId: string;
    readonly shiftId: string;
  }): Promise<{ readonly points: number; readonly ruleVersionId: string | null }>;
}

/** Default calculator — always called; awards 0 until E2-S4 rules are plugged in. */
export const zeroLosapCalculator: LosapPointsCalculator = {
  compute() {
    return Promise.resolve({ points: 0, ruleVersionId: null });
  },
};

/** Adapter that applies a static points-by-activity map (same apply step as E2-S4). */
export function createRulesLosapCalculator(
  rules: Partial<Record<ShiftActivityType, number>>,
  ruleVersionId = 'STATIC',
): LosapPointsCalculator {
  return {
    compute(input) {
      return Promise.resolve({
        points: computeLosapPoints(input.activityType, rules),
        ruleVersionId,
      });
    },
  };
}

export type CompleteShiftOutcome =
  | { readonly kind: 'COMPLETED'; readonly recordsCreated: number }
  | { readonly kind: 'ALREADY_COMPLETED' }
  | { readonly kind: 'SKIPPED_NOT_ENDED' }
  | { readonly kind: 'SKIPPED_CANCELLED' }
  | { readonly kind: 'SKIPPED_NO_CLAIMS' }
  | {
      readonly kind: 'SKIPPED_TOO_MANY_CLAIMS';
      readonly claimedCount: number;
      readonly maxSupported: number;
    }
  /**
   * A non-idempotency TransactWriteCommand item (an ATTENDANCE_RECORD or LOSAP_POINT_ENTRY Put)
   * failed its own ConditionExpression while the shift's own completion guard held — a genuine
   * sort-key collision with an unrelated record, not a duplicate completion. Nothing was written
   * (TransactWriteItems is all-or-nothing) and the shift was NOT flagged complete, so it will be
   * retried. Callers must log and meter this distinctly rather than treating it as success.
   */
  | { readonly kind: 'ATTENDANCE_CONFLICT' }
  | { readonly kind: 'NOT_FOUND' }
  /** Synthesized by completionHandler.ts when a per-shift call throws; never returned here. */
  | { readonly kind: 'FAILED'; readonly reason: string };

export interface CompleteShiftOptions {
  readonly now?: number;
  readonly losapCalculator?: LosapPointsCalculator;
}

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function isShiftActivityType(value: unknown): value is ShiftActivityType {
  return typeof value === 'string' && (SHIFT_ACTIVITY_TYPES as readonly string[]).includes(value);
}

function resolveActivityType(shift: Record<string, unknown>): ShiftActivityType {
  return isShiftActivityType(shift.activityType) ? shift.activityType : 'STANDBY';
}

/** startAtMs/endAtMs are epoch milliseconds (DUTY_SHIFT convention — see module doc comment). */
function hoursBetween(startAtMs: number, endAtMs: number): number {
  return (endAtMs - startAtMs) / 3_600_000;
}

function asTransactionCancellation(error: unknown): TransactionCanceledException | undefined {
  return error instanceof TransactionCanceledException ? error : undefined;
}

export async function completeShiftAttendance(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  options: CompleteShiftOptions = {},
): Promise<CompleteShiftOutcome> {
  const now = options.now ?? Date.now();
  const losapCalculator = options.losapCalculator ?? zeroLosapCalculator;
  const shiftPk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);

  const result = await doc.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :shiftPk',
      ExpressionAttributeValues: { ':shiftPk': shiftPk },
      ConsistentRead: true,
    }),
  );
  const items = result.Items ?? [];
  const shift = items.find((item) => item.sk === 'METADATA');
  if (!shift) {
    return { kind: 'NOT_FOUND' };
  }
  if (shift.status === 'CANCELLED') {
    return { kind: 'SKIPPED_CANCELLED' };
  }
  if (typeof shift.attendanceCompletedAt === 'number') {
    return { kind: 'ALREADY_COMPLETED' };
  }

  const startAt: unknown = shift['startAt'];
  const endAt: unknown = shift['endAt'];
  if (typeof startAt !== 'number' || typeof endAt !== 'number') {
    throw new Error(
      `DUTY_SHIFT ${shiftId} is missing numeric startAt/endAt; refusing attendance completion`,
    );
  }
  if (endAt > now) {
    return { kind: 'SKIPPED_NOT_ENDED' };
  }

  const claimedPositions = items.filter(
    (item) =>
      typeof item.sk === 'string' &&
      item.sk.startsWith('POSITION#') &&
      typeof item.claimedByMemberId === 'string',
  );
  if (claimedPositions.length === 0) {
    return { kind: 'SKIPPED_NO_CLAIMS' };
  }
  if (claimedPositions.length > MAX_CLAIMED_POSITIONS_PER_TRANSACTION) {
    return {
      kind: 'SKIPPED_TOO_MANY_CLAIMS',
      claimedCount: claimedPositions.length,
      maxSupported: MAX_CLAIMED_POSITIONS_PER_TRANSACTION,
    };
  }

  const activityType = resolveActivityType(shift);
  const hours = hoursBetween(startAt, endAt);
  // ATTENDANCE_RECORD.occurredAt / ATTENDANCE#{occurredAt} sort keys are epoch SECONDS (see
  // attendance/handler.ts) — convert from the shift domain's milliseconds at this boundary so
  // shift-derived and manually-submitted attendance share one sortable key space (AC3).
  const occurredAtSeconds = Math.floor(endAt / 1000);
  const year = new Date(endAt).getUTCFullYear();
  const transactItems: TransactItem[] = [];

  for (const position of claimedPositions) {
    const memberId = position.claimedByMemberId as string;
    const keys = buildAttendanceKeys(deptId, memberId, occurredAtSeconds);
    const award = await losapCalculator.compute({
      activityType,
      hours,
      deptId,
      memberId,
      shiftId,
    });

    const attendanceItem = {
      ...keys,
      entityType: 'ATTENDANCE_RECORD',
      activityType,
      refId: shiftId,
      occurredAt: occurredAtSeconds,
      hours,
      losapPointsAwarded: award.points,
    };

    transactItems.push({
      Put: {
        TableName: tableName,
        Item: attendanceItem,
        ConditionExpression: 'attribute_not_exists(sk)',
      },
    });

    if (award.ruleVersionId !== null) {
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: buildLosapEntryItem({
            deptId,
            memberId,
            year,
            activityType,
            points: award.points,
            sourceRefId: keys.sk,
            ruleVersionId: award.ruleVersionId,
            entryId: randomUUID(),
          }),
          ConditionExpression: 'attribute_not_exists(sk)',
        },
      });
    }

    transactItems.push({
      Put: {
        TableName: tableName,
        Item: buildOutboxRecord(
          deptId,
          'personnel-service',
          'personnel.attendance.recorded',
          memberId,
          {
            deptId,
            memberId,
            activityType,
            activityId: shiftId,
            losapPoints: award.points,
          },
        ),
      },
    });
  }

  const shiftUpdateIndex = transactItems.length;
  transactItems.push({
    Update: {
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId), sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(attendanceCompletedAt)',
      UpdateExpression: 'SET attendanceCompletedAt = :completedAt',
      ExpressionAttributeValues: { ':completedAt': now },
    },
  });

  try {
    await doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    const cancellation = asTransactionCancellation(error);
    const reasons = cancellation?.CancellationReasons;
    if (reasons !== undefined) {
      const shiftUpdateReason = reasons[shiftUpdateIndex];
      if (shiftUpdateReason?.Code === 'ConditionalCheckFailed') {
        // The shift METADATA Update's own attendanceCompletedAt guard failed — another
        // invocation (concurrent or redelivered) already completed this shift. Idempotent
        // success; retries must never duplicate records.
        return { kind: 'ALREADY_COMPLETED' };
      }
      if (reasons.some((reason) => reason?.Code === 'ConditionalCheckFailed')) {
        // A different item's condition failed (an ATTENDANCE_RECORD/LOSAP_POINT_ENTRY Put's
        // attribute_not_exists(sk) guard) while the shift's own condition held. That is a
        // genuine sort-key collision with an unrelated record, not a duplicate completion — the
        // whole transaction cancelled, so nothing was written and the shift is not flagged
        // complete. Do not report ALREADY_COMPLETED.
        return { kind: 'ATTENDANCE_CONFLICT' };
      }
    }
    throw error;
  }

  return { kind: 'COMPLETED', recordsCreated: claimedPositions.length };
}

export async function findEndedShiftsWithClaims(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  now: number,
): Promise<readonly string[]> {
  const gsi3pk = buildDeptScopedPk(deptId, 'DUTY_SHIFT');
  const candidateShiftIds: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI3_INDEX_NAME,
        KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk <= :nowSk',
        FilterExpression:
          'entityType = :dutyShift AND endAt <= :nowNum AND attribute_not_exists(attendanceCompletedAt) AND #status <> :cancelled',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':gsi3pk': gsi3pk,
          ':nowSk': String(now),
          ':nowNum': now,
          ':dutyShift': 'DUTY_SHIFT',
          ':cancelled': 'CANCELLED',
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of page.Items ?? []) {
      if (typeof item.endAt === 'number' && item.endAt > now) {
        continue;
      }
      const shiftId =
        typeof item.shiftId === 'string'
          ? item.shiftId
          : typeof item.pk === 'string'
            ? item.pk.split('#').at(-1)
            : undefined;
      if (shiftId) {
        candidateShiftIds.push(shiftId);
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  // Bounded-concurrency fan-out instead of one sequential await per candidate shift (N+1);
  // mirrors coverageRepository.ts's mapWithConcurrency use for the same shift-partition fetch
  // pattern. Order is preserved so callers get a stable shiftId ordering per invocation.
  const claimedOrUndefined = await mapWithConcurrency(
    candidateShiftIds,
    CLAIM_CHECK_CONCURRENCY,
    async (shiftId) => {
      const partition = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :shiftPk',
          ExpressionAttributeValues: {
            ':shiftPk': buildDeptScopedPk(deptId, 'SHIFT', shiftId),
          },
          ConsistentRead: true,
        }),
      );
      const hasClaim = (partition.Items ?? []).some(
        (row) =>
          typeof row.sk === 'string' &&
          row.sk.startsWith('POSITION#') &&
          typeof row.claimedByMemberId === 'string',
      );
      return hasClaim ? shiftId : undefined;
    },
  );

  return claimedOrUndefined.filter((shiftId): shiftId is string => shiftId !== undefined);
}
