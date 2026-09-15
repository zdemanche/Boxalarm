import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type FakeItem = Record<string, unknown>;

function itemKey(item: FakeItem): string {
  return `${item.pk as string}#${item.sk as string}`;
}

function resolveAttr(rawAttr: string, names: Record<string, string>): string | undefined {
  return rawAttr.startsWith('#') ? names[rawAttr] : rawAttr;
}

function evaluateClause(
  clause: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
  names: Record<string, string>,
): boolean {
  const trimmed = clause.trim();
  const existsFn = /^attribute_exists\(([#\w]+)\)$/.exec(trimmed);
  if (existsFn) {
    const attr = resolveAttr(existsFn[1] ?? '', names) ?? '';
    return item !== undefined && item[attr] !== undefined;
  }
  const notExists = /^attribute_not_exists\(([#\w]+)\)$/.exec(trimmed);
  if (notExists) {
    const attr = resolveAttr(notExists[1] ?? '', names) ?? '';
    return item === undefined || item[attr] === undefined;
  }
  const equals = /^(#?\w+)\s*=\s*(:\w+)$/.exec(trimmed);
  if (equals) {
    const attr = resolveAttr(equals[1] ?? '', names) ?? '';
    const valueKey = equals[2] ?? '';
    return item !== undefined && item[attr] === values[valueKey];
  }
  throw new Error(`testDynamoFake does not support condition clause: ${trimmed}`);
}

function evaluateCondition(
  expression: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
  names: Record<string, string> = {},
): boolean {
  return expression.split(/\s+AND\s+/i).every((clause) => {
    const trimmed = clause.trim();
    const grouped = /^\((.*)\)$/.exec(trimmed);
    if (grouped) {
      return (grouped[1] ?? '')
        .split(/\s+OR\s+/i)
        .some((sub) => evaluateClause(sub, item, values, names));
    }
    return evaluateClause(trimmed, item, values, names);
  });
}

function applyUpdate(
  existing: FakeItem | undefined,
  key: FakeItem,
  input: Record<string, unknown>,
): FakeItem {
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const expression = input.UpdateExpression as string;
  const next: FakeItem = { ...(existing ?? key) };

  const setMatch = /SET\s+(.+?)(?=\s+REMOVE\s+|$)/is.exec(expression);
  if (setMatch) {
    for (const assignment of (setMatch[1] ?? '').split(',')) {
      const parts = assignment.split('=').map((part) => part.trim());
      const rawAttr = parts[0];
      const rawValue = parts[1];
      const attr = rawAttr ? resolveAttr(rawAttr, names) : undefined;
      if (attr && rawValue !== undefined) {
        next[attr] = values[rawValue];
      }
    }
  }

  const removeMatch = /REMOVE\s+(.+)$/is.exec(expression);
  if (removeMatch) {
    for (const rawAttr of (removeMatch[1] ?? '').split(',')) {
      const attr = resolveAttr(rawAttr.trim(), names);
      if (attr) {
        delete next[attr];
      }
    }
  }

  return next;
}

interface TransactItem {
  readonly Put?: { readonly TableName: string; readonly Item: FakeItem };
  readonly Update?: {
    readonly TableName: string;
    readonly Key: FakeItem;
    readonly ConditionExpression?: string;
    readonly UpdateExpression: string;
    readonly ExpressionAttributeValues?: Record<string, unknown>;
    readonly ExpressionAttributeNames?: Record<string, string>;
  };
  readonly ConditionCheck?: {
    readonly Key: FakeItem;
    readonly ConditionExpression: string;
    readonly ExpressionAttributeValues?: Record<string, unknown>;
    readonly ExpressionAttributeNames?: Record<string, string>;
  };
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
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      if (condition && !evaluateCondition(condition, existing, values, names)) {
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

    if (name === 'TransactWriteCommand') {
      const items = (input.TransactItems ?? []) as readonly TransactItem[];
      const reasons: string[] = [];
      let anyFailed = false;

      for (const item of items) {
        if (item.ConditionCheck) {
          const { Key, ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames } =
            item.ConditionCheck;
          const existing = store.get(itemKey(Key));
          const ok = evaluateCondition(
            ConditionExpression,
            existing,
            ExpressionAttributeValues ?? {},
            ExpressionAttributeNames ?? {},
          );
          reasons.push(ok ? 'None' : 'ConditionalCheckFailed');
          if (!ok) anyFailed = true;
        } else if (item.Update) {
          const { Key, ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames } =
            item.Update;
          const existing = store.get(itemKey(Key));
          const ok =
            !ConditionExpression ||
            evaluateCondition(
              ConditionExpression,
              existing,
              ExpressionAttributeValues ?? {},
              ExpressionAttributeNames ?? {},
            );
          reasons.push(ok ? 'None' : 'ConditionalCheckFailed');
          if (!ok) anyFailed = true;
        } else {
          reasons.push('None');
        }
      }

      if (anyFailed) {
        return Promise.reject(
          new TransactionCanceledException({
            message:
              'Transaction cancelled, please refer cancellation reasons for specific reasons',
            CancellationReasons: reasons.map((Code) => ({ Code })),
            $metadata: {},
          }),
        );
      }

      for (const item of items) {
        if (item.Put) {
          store.set(itemKey(item.Put.Item), item.Put.Item);
        } else if (item.Update) {
          const { Key } = item.Update;
          store.set(itemKey(Key), applyUpdate(store.get(itemKey(Key)), Key, item.Update));
        }
      }
      return Promise.resolve({});
    }

    return Promise.reject(new Error(`testDynamoFake does not support command: ${name}`));
  };

  const peek = (partitionKey: string, sortKey: string): FakeItem | undefined =>
    store.get(`${partitionKey}#${sortKey}`);

  return { send, peek } as unknown as FakeDocumentClient;
}
