import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { DEDUP_TTL_SECONDS, PROJECTION_CONSUMER_NAME } from './constants.js';
import { projectionWrites, type DomainEvent, type ProjectionWrite } from './events.js';

const DEFAULT_CLOCK = 'eventAt';

function isDuplicate(error: unknown): boolean {
  if (!(error instanceof TransactionCanceledException)) {
    return false;
  }
  return error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

function isStale(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
}

interface Clock {
  readonly name: string;
  readonly ms: number;
}

function attributeUpdate(
  tableName: string,
  deptId: VerifiedDeptId,
  sk: string,
  values: Readonly<Record<string, unknown>>,
  clock?: Clock,
): {
  readonly Update: {
    readonly TableName: string;
    readonly Key: { readonly pk: string; readonly sk: string };
    readonly UpdateExpression: string;
    readonly ConditionExpression?: string;
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
  const removes: string[] = [];
  if (clock) {
    names['#clock'] = clock.name;
    exprValues[':clockMs'] = clock.ms;
    sets.push('#clock = :clockMs');
    for (const live of ['removed', 'ttl']) {
      if (!(live in values)) {
        names[`#${live}`] = live;
        removes.push(`#${live}`);
      }
    }
  }
  return {
    Update: {
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'REPORTING_ROLLUP'), sk },
      UpdateExpression:
        `SET ${sets.join(', ')}` + (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : ''),
      ...(clock
        ? { ConditionExpression: 'attribute_not_exists(#clock) OR #clock <= :clockMs' }
        : {}),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: exprValues,
    },
  };
}

function transactItem(
  tableName: string,
  deptId: VerifiedDeptId,
  write: ProjectionWrite,
  eventTimeMs: number,
  nowMs: number,
): Record<string, unknown> {
  if (write.kind === 'delete') {
    return attributeUpdate(
      tableName,
      deptId,
      write.sk,
      { removed: true, ttl: Math.floor(nowMs / 1000) + DEDUP_TTL_SECONDS },
      { name: DEFAULT_CLOCK, ms: eventTimeMs },
    );
  }
  return attributeUpdate(tableName, deptId, write.sk, write.values, {
    name: write.clock ?? DEFAULT_CLOCK,
    ms: eventTimeMs,
  });
}

export async function applyProjection(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  event: DomainEvent,
  nowMs: number,
): Promise<'applied' | 'duplicate' | 'stale'> {
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
    ...writes.map((write) =>
      transactItem(tableName, deptId, write, event.eventTimeMs ?? nowMs, nowMs),
    ),
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
    if (isStale(error)) {
      return 'stale';
    }
    throw error;
  }
}
