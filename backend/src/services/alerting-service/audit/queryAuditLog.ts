import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { mergeReceiptAttempts } from '../receipts/deliveryReceiptRepository.js';

const PAGE_SIZE = 25;
const TIMELINE_CONCURRENCY = 8;
const MIN_EPOCH_SECONDS = 1_000_000_000;
const MAX_EPOCH_SECONDS = 9_999_999_999;

export function isEpochSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_EPOCH_SECONDS && value <= MAX_EPOCH_SECONDS;
}
// TODO: E1-S3 — ESCALATION_EVENT and DISPATCH_RESPONSE_RECORD have no writer yet; once E1-S3
// ships they collocate under the same pk and this filter picks them up with zero code changes.
const TIMELINE_ENTITY_TYPES = [
  'DELIVERY_RECEIPT',
  'ESCALATION_EVENT',
  'DISPATCH_RESPONSE_RECORD',
] as const;

export class InvalidCursorError extends Error {}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidCursorError('cursor is not a valid audit log pagination token', {
      cause: error,
    });
  }
}

export interface MemberAuditPage {
  readonly entries: readonly MemberDispatchEntry[];
  readonly nextCursor?: string;
}

export interface MemberDispatchEntry {
  readonly dispatchId: string;
  readonly sentAt?: number;
}

export async function queryMemberDeliveryHistory(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  cursor?: string,
): Promise<MemberAuditPage> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
      FilterExpression: 'deptId = :deptId',
      ExpressionAttributeValues: {
        ':gsi1pk': `MEMBER#${memberId}`,
        ':prefix': 'RECEIPT#',
        ':deptId': deptId,
      },
      ScanIndexForward: false,
      Limit: PAGE_SIZE,
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
    }),
  );
  const entries = projectMemberDispatches(result.Items ?? []);
  return result.LastEvaluatedKey
    ? { entries, nextCursor: encodeCursor(result.LastEvaluatedKey) }
    : { entries };
}

function projectMemberDispatches(items: readonly Record<string, unknown>[]): MemberDispatchEntry[] {
  const byDispatch = new Map<string, number | undefined>();
  for (const item of items) {
    if (typeof item.dispatchId !== 'string') {
      continue;
    }
    const sentAt = typeof item.sentAt === 'number' ? item.sentAt : undefined;
    const prior = byDispatch.get(item.dispatchId);
    byDispatch.set(
      item.dispatchId,
      prior === undefined || (sentAt !== undefined && sentAt < prior) ? (sentAt ?? prior) : prior,
    );
  }
  return [...byDispatch].map(([dispatchId, sentAt]) => ({
    dispatchId,
    ...(sentAt !== undefined ? { sentAt } : {}),
  }));
}

export interface DispatchAuditEntry {
  readonly dispatchId: string;
  readonly dispatch: Record<string, unknown>;
  readonly timeline: readonly Record<string, unknown>[];
}

export interface DepartmentAuditPage {
  readonly entries: readonly DispatchAuditEntry[];
  readonly nextCursor?: string;
}

async function queryDispatchTimeline(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId?: string,
): Promise<readonly Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: memberId
          ? 'entityType IN (:t0, :t1, :t2) AND memberId = :memberId'
          : 'entityType IN (:t0, :t1, :t2)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          ':t0': TIMELINE_ENTITY_TYPES[0],
          ':t1': TIMELINE_ENTITY_TYPES[1],
          ':t2': TIMELINE_ENTITY_TYPES[2],
          ...(memberId ? { ':memberId': memberId } : {}),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return mergeTimelineReceipts(items, dispatchId);
}

function mergeTimelineReceipts(
  items: readonly Record<string, unknown>[],
  dispatchId: string,
): readonly Record<string, unknown>[] {
  const receipts = items.filter((item) => item.entityType === 'DELIVERY_RECEIPT');
  const others = items.filter((item) => item.entityType !== 'DELIVERY_RECEIPT');
  const merged = mergeReceiptAttempts(receipts).map((record) => ({
    entityType: 'DELIVERY_RECEIPT',
    dispatchId,
    ...record,
  }));
  return [...merged, ...others];
}

export async function queryMemberDispatchTimeline(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
): Promise<readonly Record<string, unknown>[]> {
  // Push the memberId filter into the DynamoDB query itself instead of fetching the whole
  // per-dispatch timeline and filtering in application code — fewer read units and less data
  // transferred for dispatches with a large roster.
  return queryDispatchTimeline(client, tableName, deptId, dispatchId, memberId);
}

export async function queryDepartmentAuditLog(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  from: number,
  to: number,
  cursor?: string,
): Promise<DepartmentAuditPage> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':gsi2pk': buildDeptScopedPk(deptId),
        ':from': `DISPATCH#${from}`,
        ':to': `DISPATCH#${to}`,
      },
      ScanIndexForward: true,
      Limit: PAGE_SIZE,
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
    }),
  );

  const dispatches = (result.Items ?? []) as Record<string, unknown>[];
  const withIds = dispatches.flatMap((dispatch) =>
    typeof dispatch.dispatchId === 'string' ? [{ dispatchId: dispatch.dispatchId, dispatch }] : [],
  );
  const entries: DispatchAuditEntry[] = [];
  for (let start = 0; start < withIds.length; start += TIMELINE_CONCURRENCY) {
    const batch = withIds.slice(start, start + TIMELINE_CONCURRENCY);
    const timelines = await Promise.all(
      batch.map(({ dispatchId }) => queryDispatchTimeline(client, tableName, deptId, dispatchId)),
    );
    batch.forEach(({ dispatchId, dispatch }, index) => {
      entries.push({ dispatchId, dispatch, timeline: timelines[index] ?? [] });
    });
  }

  return result.LastEvaluatedKey
    ? { entries, nextCursor: encodeCursor(result.LastEvaluatedKey) }
    : { entries };
}
