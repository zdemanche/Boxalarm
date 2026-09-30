import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Test double for the alerting table as the CAD ingress path uses it: Get, conditional Put
 * (attribute_not_exists on the key), Delete, and createManualDispatch's transaction (its
 * first item, the idempotency lock, is the condition). Not a DynamoDB emulator - the
 * LocalStack chain test (cadWebhookChain.integration.test.ts) covers the real table.
 */
export interface FakeTable {
  items: Map<string, Record<string, unknown>>;
  failTransact?: boolean;
}

export function fakeDynamo(table: FakeTable): DynamoDBDocumentClient {
  const keyOf = (item: Record<string, unknown>) => `${String(item.pk)}|${String(item.sk)}`;
  const send = (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'GetCommand') {
      return Promise.resolve({
        Item: table.items.get(keyOf(input.Key as Record<string, unknown>)),
      });
    }
    if (name === 'PutCommand') {
      const item = input.Item as Record<string, unknown>;
      if (table.items.has(keyOf(item))) {
        return Promise.reject(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
      }
      table.items.set(keyOf(item), item);
      return Promise.resolve({});
    }
    if (name === 'DeleteCommand') {
      table.items.delete(keyOf(input.Key as Record<string, unknown>));
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      if (table.failTransact) return Promise.reject(new Error('dynamo down'));
      const entries = input.TransactItems as {
        Put: { Item: Record<string, unknown>; ConditionExpression?: string };
      }[];
      // Every conditional Put here is attribute_not_exists on its key (an expired lock or
      // marker, per its own expiry field, counts as absent - as the real conditions say).
      const reasons = entries.map((entry) => {
        const existing = table.items.get(keyOf(entry.Put.Item));
        const expired =
          existing !== undefined &&
          ((typeof existing.ttl === 'number' &&
            entry.Put.Item.entityType === 'CAD_REPLAY_MARKER' &&
            existing.ttl <= Number(entry.Put.Item.createdAt)) ||
            (typeof existing.expiresAt === 'number' &&
              existing.expiresAt <= Number(entry.Put.Item.createdAt)));
        return entry.Put.ConditionExpression && existing && !expired
          ? { Code: 'ConditionalCheckFailed' }
          : { Code: 'None' };
      });
      if (reasons.some((r) => r.Code !== 'None')) {
        return Promise.reject(
          new TransactionCanceledException({
            message: 'x',
            $metadata: {},
            CancellationReasons: reasons,
          }),
        );
      }
      for (const entry of entries) table.items.set(keyOf(entry.Put.Item), entry.Put.Item);
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected ${name}`));
  };
  return { send } as unknown as DynamoDBDocumentClient;
}
