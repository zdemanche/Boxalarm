import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { parseAuditLogEntryItem, type AuditLogEntry } from './auditEntry.js';

const PAGE_SIZE = 25;

export interface AuditTrailPage {
  readonly entries: readonly AuditLogEntry[];
  readonly nextCursor?: string;
}

export class InvalidCursorError extends Error {}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidCursorError('cursor is not a valid audit trail pagination token', {
      cause: error,
    });
  }
}

export async function queryAuditTrailForEntity(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  mutatedEntityType: string,
  mutatedEntityId: string,
  cursor?: string,
): Promise<AuditTrailPage> {
  if (!mutatedEntityType) {
    throw new Error('mutatedEntityType is required to query the audit trail');
  }
  if (!mutatedEntityId) {
    throw new Error('mutatedEntityId is required to query the audit trail');
  }

  const gsi3pk = buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', mutatedEntityType, mutatedEntityId);
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :gsi3pk',
      ExpressionAttributeValues: { ':gsi3pk': gsi3pk },
      ScanIndexForward: false,
      Limit: PAGE_SIZE,
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor) } : {}),
    }),
  );

  const entries = (result.Items ?? []).map((item) => parseAuditLogEntryItem(item));
  return result.LastEvaluatedKey
    ? { entries, nextCursor: encodeCursor(result.LastEvaluatedKey) }
    : { entries };
}
