import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { mapWithConcurrency } from '../dynamoClient.js';

const AUDIT_QUERY_CONCURRENCY = 8;

export const MEMBER_STATUSES = ['ACTIVE', 'PROBATIONARY', 'LOA', 'RETIRED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface StatusInterval {
  readonly status: MemberStatus;
  readonly effectiveFrom: number;
}

export interface MemberTimeline {
  readonly memberId: string;
  readonly intervals: readonly StatusInterval[];
  readonly joinedAt: number;
}

interface RawMember {
  readonly memberId: string;
  readonly status: MemberStatus;
  readonly createdAt: number;
}

function isMemberStatus(value: unknown): value is MemberStatus {
  return typeof value === 'string' && (MEMBER_STATUSES as readonly string[]).includes(value);
}

function toRawMember(item: Record<string, unknown>): RawMember | undefined {
  const { memberId, status, createdAt } = item;
  if (typeof memberId !== 'string' || !isMemberStatus(status) || typeof createdAt !== 'number') {
    return undefined;
  }
  return { memberId, status, createdAt };
}

async function queryGsi3All(
  client: DynamoDBDocumentClient,
  tableName: string,
  gsi3pk: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': gsi3pk },
        ScanIndexForward: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

interface StatusChange extends StatusInterval {
  readonly oldStatus?: MemberStatus;
}

function toStatusChange(item: Record<string, unknown>): StatusChange | undefined {
  const changedFields = item.changedFields as
    { status?: { old?: unknown; new?: unknown } } | undefined;
  const newStatus = changedFields?.status?.new;
  const oldStatus = changedFields?.status?.old;
  const ts = item.ts;
  if (!isMemberStatus(newStatus) || typeof ts !== 'number') {
    return undefined;
  }
  return isMemberStatus(oldStatus)
    ? { status: newStatus, effectiveFrom: ts, oldStatus }
    : { status: newStatus, effectiveFrom: ts };
}

function buildTimelineParts(
  member: RawMember,
  auditItems: readonly Record<string, unknown>[],
): { intervals: readonly StatusInterval[]; joinedAt: number } {
  const memberAuditItems = auditItems.filter((item) => item.mutatedEntityType === 'MEMBER');

  const createTs = memberAuditItems.find(
    (item) => item.action === 'CREATE' && typeof item.ts === 'number',
  )?.ts;
  const joinedAt = typeof createTs === 'number' ? createTs : member.createdAt;

  const statusChanges = memberAuditItems
    .map(toStatusChange)
    .filter((change): change is StatusChange => change !== undefined)
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom);

  const [earliest] = statusChanges;
  if (!earliest) {
    return { intervals: [{ status: member.status, effectiveFrom: member.createdAt }], joinedAt };
  }

  const intervals: StatusInterval[] =
    earliest.effectiveFrom > member.createdAt
      ? [
          { status: earliest.oldStatus ?? member.status, effectiveFrom: member.createdAt },
          ...statusChanges.map(({ status, effectiveFrom }) => ({ status, effectiveFrom })),
        ]
      : statusChanges.map(({ status, effectiveFrom }) => ({ status, effectiveFrom }));

  return { intervals, joinedAt };
}

export function statusAt(timeline: MemberTimeline, atMs: number): MemberStatus | undefined {
  let current: MemberStatus | undefined;
  for (const interval of timeline.intervals) {
    if (interval.effectiveFrom > atMs) {
      break;
    }
    current = interval.status;
  }
  return current;
}

export async function fetchMemberTimelines(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly MemberTimeline[]> {
  const memberItems = await queryGsi3All(client, tableName, buildDeptScopedPk(deptId, 'MEMBER'));
  const members = memberItems
    .map(toRawMember)
    .filter((member): member is RawMember => member !== undefined);

  return mapWithConcurrency(members, AUDIT_QUERY_CONCURRENCY, async (member) => {
    const auditItems = await queryGsi3All(
      client,
      tableName,
      buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'MEMBER', member.memberId),
    );
    const { intervals, joinedAt } = buildTimelineParts(member, auditItems);
    return { memberId: member.memberId, intervals, joinedAt };
  });
}

const MEMBER_QUERY_CONCURRENCY = 8;

export const ACTIVITY_TYPES = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface AttendanceRecord {
  readonly memberId: string;
  readonly activityType: ActivityType;
  readonly occurredAt: number;
}

function isActivityType(value: unknown): value is ActivityType {
  return typeof value === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(value);
}

function toAttendanceRecord(
  memberId: string,
  item: Record<string, unknown>,
): AttendanceRecord | undefined {
  const { activityType, occurredAt } = item;
  if (!isActivityType(activityType) || typeof occurredAt !== 'number') {
    return undefined;
  }
  return { memberId, activityType, occurredAt: occurredAt * 1000 };
}

async function fetchAttendanceForMember(
  client: DynamoDBDocumentClient,
  tableName: string,
  memberId: string,
  startSec: number,
  endSec: number,
): Promise<readonly AttendanceRecord[]> {
  const records: AttendanceRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':from': `ATTENDANCE_RECORD#${startSec}`,
          ':to': `ATTENDANCE_RECORD#${endSec}`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const record = toAttendanceRecord(memberId, item);
      if (record) {
        records.push(record);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return records;
}

export async function fetchAttendanceRecords(
  client: DynamoDBDocumentClient,
  tableName: string,
  memberIds: readonly string[],
  startMs: number,
  endMs: number,
): Promise<readonly AttendanceRecord[]> {
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const perMember = await mapWithConcurrency(memberIds, MEMBER_QUERY_CONCURRENCY, (memberId) =>
    fetchAttendanceForMember(client, tableName, memberId, startSec, endSec),
  );
  return perMember.flat();
}
