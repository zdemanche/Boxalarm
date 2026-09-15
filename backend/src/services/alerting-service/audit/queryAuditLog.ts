import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const PAGE_SIZE = 25;
// TODO: E1-S3 — ESCALATION_EVENT and DISPATCH_RESPONSE_RECORD have no writer yet; once E1-S3
// ships they collocate under the same pk and this filter picks them up with zero code changes.
const TIMELINE_ENTITY_TYPES = new Set([
  'DELIVERY_RECEIPT',
  'ESCALATION_EVENT',
  'DISPATCH_RESPONSE_RECORD',
]);

export class InvalidCursorError extends Error {}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new InvalidCursorError('cursor is not a valid audit log pagination token', {
      cause: error,
    });
  }
}

export interface MemberAuditPage {
  readonly entries: readonly Record<string, unknown>[];
  readonly nextCursor?: string;
}

export async function queryMemberDeliveryHistory(
  client: DynamoDBDocumentClient,
  tableName: string,
  memberId: string,
  cursor?: string,
): Promise<MemberAuditPage> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
      ExpressionAttributeValues: {
        ':gsi1pk': `MEMBER#${memberId}`,
        ':prefix': 'RECEIPT#',
      },
      ScanIndexForward: false,
      Limit: PAGE_SIZE,
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
    }),
  );
  const entries = result.Items ?? [];
  return result.LastEvaluatedKey
    ? { entries, nextCursor: encodeCursor(result.LastEvaluatedKey) }
    : { entries };
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
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId) },
    }),
  );
  return (result.Items ?? []).filter(
    (item) => typeof item.entityType === 'string' && TIMELINE_ENTITY_TYPES.has(item.entityType),
  );
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
  const entries: DispatchAuditEntry[] = [];
  for (const dispatch of dispatches) {
    const dispatchId = dispatch.dispatchId;
    if (typeof dispatchId !== 'string') {
      continue;
    }
    const timeline = await queryDispatchTimeline(client, tableName, deptId, dispatchId);
    entries.push({ dispatchId, dispatch, timeline });
  }

  return result.LastEvaluatedKey
    ? { entries, nextCursor: encodeCursor(result.LastEvaluatedKey) }
    : { entries };
}
