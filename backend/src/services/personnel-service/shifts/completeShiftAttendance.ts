import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildAttendanceKeys, type ActivityType } from '../attendance/handler.js';
import { buildLosapEntryItem } from '../losap/repository.js';
import { computeLosapPoints } from '../losap/rules.js';

/** Shift-sourced attendance only uses these two activity types (subset of ActivityType). */
export type ShiftActivityType = Extract<ActivityType, 'STANDBY' | 'WORK_DETAIL'>;

const SHIFT_ACTIVITY_TYPES = [
  'STANDBY',
  'WORK_DETAIL',
] as const satisfies readonly ShiftActivityType[];
const GSI3_INDEX_NAME = 'gsi3';

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
  | { readonly kind: 'NOT_FOUND' };

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

function hoursBetween(startAt: number, endAt: number): number {
  return (endAt - startAt) / 3600;
}

function asTransactionCancellation(error: unknown): TransactionCanceledException | undefined {
  return error instanceof TransactionCanceledException ? error : undefined;
}

function buildAttendanceOutboxItem(input: {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly shiftId: string;
  readonly activityType: ShiftActivityType;
  readonly losapPoints: number;
  readonly occurredAt: number;
}): Record<string, unknown> {
  const eventId = randomUUID();
  return {
    pk: buildDeptScopedPk(input.deptId, 'OUTBOX', 'MEMBER', input.memberId),
    sk: `EVT#${eventId}`,
    entityType: 'OUTBOX_ENTRY',
    eventId,
    eventType: 'personnel.attendance.recorded',
    correlationId: input.memberId,
    createdAt: input.occurredAt,
    payload: {
      deptId: input.deptId,
      memberId: input.memberId,
      activityType: input.activityType,
      activityId: input.shiftId,
      losapPoints: input.losapPoints,
    },
  };
}

export async function completeShiftAttendance(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  options: CompleteShiftOptions = {},
): Promise<CompleteShiftOutcome> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
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

  const activityType = resolveActivityType(shift);
  const hours = hoursBetween(startAt, endAt);
  const year = new Date(endAt * 1000).getUTCFullYear();
  const transactItems: TransactItem[] = [];

  for (const position of claimedPositions) {
    const memberId = position.claimedByMemberId as string;
    const keys = buildAttendanceKeys(deptId, memberId, endAt);
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
      occurredAt: endAt,
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
        Item: buildAttendanceOutboxItem({
          deptId,
          memberId,
          shiftId,
          activityType,
          losapPoints: award.points,
          occurredAt: endAt,
        }),
      },
    });
  }

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
    if (cancellation?.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) {
      // Concurrent or redelivered completion — attendance Put / shift Update conditions
      // failed. Treat as idempotent success so retries never duplicate records.
      return { kind: 'ALREADY_COMPLETED' };
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
  const shiftIds: string[] = [];
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
      if (!shiftId) {
        continue;
      }

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
      if (hasClaim) {
        shiftIds.push(shiftId);
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return shiftIds;
}
