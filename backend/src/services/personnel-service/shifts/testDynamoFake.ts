import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type FakeItem = Record<string, unknown>;

function itemKey(item: FakeItem): string {
  return `${item.pk as string}#${item.sk as string}`;
}

function evaluateClause(
  clause: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
): boolean {
  const trimmed = clause.trim();
  const exists = /^attribute_exists\((\w+)\)$/.exec(trimmed);
  if (exists) {
    const attr = exists[1] ?? '';
    return item !== undefined && item[attr] !== undefined;
  }
  const notExists = /^attribute_not_exists\((\w+)\)$/.exec(trimmed);
  if (notExists) {
    const attr = notExists[1] ?? '';
    return item === undefined || item[attr] === undefined;
  }
  const equals = /^(\w+)\s*=\s*(:\w+)$/.exec(trimmed);
  if (equals) {
    const attr = equals[1] ?? '';
    const valueKey = equals[2] ?? '';
    return item !== undefined && item[attr] === values[valueKey];
  }
  throw new Error(`testDynamoFake does not support condition clause: ${trimmed}`);
}

function evaluateCondition(
  expression: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
): boolean {
  return expression.split(/\s+AND\s+/i).every((clause) => {
    const trimmed = clause.trim();
    const grouped = /^\((.*)\)$/.exec(trimmed);
    if (grouped) {
      return (grouped[1] ?? '').split(/\s+OR\s+/i).some((sub) => evaluateClause(sub, item, values));
    }
    return evaluateClause(trimmed, item, values);
  });
}

function applyUpdate(
  existing: FakeItem | undefined,
  key: FakeItem,
  input: Record<string, unknown>,
): FakeItem {
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const setClause = (input.UpdateExpression as string).replace(/^SET\s+/i, '');
  const next: FakeItem = { ...(existing ?? key) };
  for (const assignment of setClause.split(',')) {
    const parts = assignment.split('=').map((part) => part.trim());
    const rawAttr = parts[0];
    const rawValue = parts[1];
    const attr = rawAttr?.startsWith('#') ? names[rawAttr] : rawAttr;
    if (attr && rawValue !== undefined) {
      next[attr] = values[rawValue];
    }
  }
  return next;
}

export type FakeDocumentClient = DynamoDBDocumentClient & {
  readonly peek: (partitionKey: string, sortKey: string) => FakeItem | undefined;
};

export function createFakeDocumentClient(seed: readonly FakeItem[] = []): FakeDocumentClient {
  const store = new Map<string, FakeItem>();
  for (const item of seed) {
    store.set(itemKey(item), item);
  }

  const send = (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;

    if (name === 'GetCommand') {
      const key = input.Key as FakeItem;
      return Promise.resolve({ Item: store.get(itemKey(key)) });
    }

    if (name === 'QueryCommand') {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const wantedPk = values[':shiftPk'];
      const items = [...store.values()].filter((item) => item.pk === wantedPk);
      return Promise.resolve({ Items: items });
    }

    if (name === 'UpdateCommand') {
      const key = input.Key as FakeItem;
      const lookupKey = itemKey(key);
      const existing = store.get(lookupKey);
      const condition = input.ConditionExpression as string | undefined;
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      if (condition && !evaluateCondition(condition, existing, values)) {
        return Promise.reject(
          new ConditionalCheckFailedException({
            message: 'The conditional request failed',
            $metadata: {},
          }),
        );
      }
      store.set(lookupKey, applyUpdate(existing, key, input));
      return Promise.resolve({});
    }

    return Promise.reject(new Error(`testDynamoFake does not support command: ${name}`));
  };

  const peek = (partitionKey: string, sortKey: string): FakeItem | undefined =>
    store.get(`${partitionKey}#${sortKey}`);

  return { send, peek } as unknown as FakeDocumentClient;
}
