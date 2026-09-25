import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { DEDUP_TTL_SECONDS, PROJECTION_CONSUMER_NAME } from './constants.js';
import { projectionWrites, type DomainEvent, type ProjectionWrite } from './events.js';

function isDuplicate(error: unknown): boolean {
  if (!(error instanceof TransactionCanceledException)) {
    return false;
  }
  return error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

function attributeUpdate(
  tableName: string,
  deptId: VerifiedDeptId,
  sk: string,
  values: Readonly<Record<string, unknown>>,
): {
  readonly Update: {
    readonly TableName: string;
    readonly Key: { readonly pk: string; readonly sk: string };
    readonly UpdateExpression: string;
    readonly ExpressionAttributeNames: Record<string, string>;
    readonly ExpressionAttributeValues: Record<string, unknown>;
  };
} {
  const names: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    names[`#${key}`] = key;
    exprValues[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  return {
    Update: {
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'REPORTING_ROLLUP'), sk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: exprValues,
    },
  };
}

function transactItem(
  tableName: string,
  deptId: VerifiedDeptId,
  write: ProjectionWrite,
): Record<string, unknown> {
  if (write.kind === 'delete') {
    return {
      Delete: {
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'REPORTING_ROLLUP'), sk: write.sk },
      },
    };
  }
  return attributeUpdate(tableName, deptId, write.sk, write.values);
}

export async function applyProjection(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  event: DomainEvent,
  nowMs: number,
): Promise<'applied' | 'duplicate'> {
  const writes = projectionWrites(event, nowMs);
  const ttl = Math.floor(nowMs / 1000) + DEDUP_TTL_SECONDS;
  const items: Record<string, unknown>[] = [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'DEDUP', PROJECTION_CONSUMER_NAME),
          sk: `EVT#${event.eventId}`,
          entityType: 'EVENT_DEDUP',
          consumerName: PROJECTION_CONSUMER_NAME,
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(sk)',
      },
    },
    ...writes.map((write) => transactItem(tableName, deptId, write)),
  ];
  if (writes.length > 0) {
    items.push(
      attributeUpdate(tableName, deptId, 'META', {
        entityType: 'REPORTING_ROLLUP_META',
        updatedAt: nowMs,
      }),
    );
  }

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: items,
      }),
    );
    return 'applied';
  } catch (error) {
    if (isDuplicate(error)) {
      return 'duplicate';
    }
    throw error;
  }
}
