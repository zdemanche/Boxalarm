import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type FakeItem = Record<string, unknown>;

function itemKey(item: FakeItem): string {
  return `${item.pk as string}#${item.sk as string}`;
}

function evaluateClause(
  clause: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
  names: Record<string, string>,
): boolean {
  const trimmed = clause.trim();
  const resolveAttr = (raw: string): string => (raw.startsWith('#') ? (names[raw] ?? raw) : raw);

  const existsFn = /^attribute_exists\(([#\w]+)\)$/.exec(trimmed);
  if (existsFn) {
    const attr = resolveAttr(existsFn[1] ?? '');
    return item !== undefined && item[attr] !== undefined;
  }
  const notExists = /^attribute_not_exists\(([#\w]+)\)$/.exec(trimmed);
  if (notExists) {
    const attr = resolveAttr(notExists[1] ?? '');
    return item === undefined || item[attr] === undefined;
  }
  const equals = /^(#?\w+)\s*=\s*(:\w+)$/.exec(trimmed);
  if (equals) {
    const attr = resolveAttr(equals[1] ?? '');
    return item !== undefined && item[attr] === values[equals[2] ?? ''];
  }
  throw new Error(`ridingBoard testDynamoFake does not support condition clause: ${trimmed}`);
}

function evaluateCondition(
  expression: string,
  item: FakeItem | undefined,
  values: Record<string, unknown>,
  names: Record<string, string> = {},
): boolean {
  if (!/\sAND\s/i.test(expression) && /\sOR\s/i.test(expression)) {
    return expression
      .split(/\s+OR\s+/i)
      .some((clause) => evaluateClause(clause.trim(), item, values, names));
  }
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
  const setMatch = /SET\s+(.+)$/is.exec(expression);
  if (setMatch) {
    for (const assignment of (setMatch[1] ?? '').split(',')) {
      const [rawAttr, rawValue] = assignment.split('=').map((part) => part.trim());
      const attr = rawAttr ? (rawAttr.startsWith('#') ? names[rawAttr] : rawAttr) : undefined;
      if (attr && rawValue !== undefined) {
        next[attr] = values[rawValue];
      }
    }
  }
  return next;
}

interface TransactItem {
  readonly Put?: { readonly Item: FakeItem };
  readonly Update?: {
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
  readonly put: (item: FakeItem) => void;
};

export function createRidingBoardFakeClient(seed: readonly FakeItem[] = []): FakeDocumentClient {
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
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      let items = [...store.values()];
      if (input.IndexName === 'GSI3') {
        const gsi3pk = values[':gsi3pk'] ?? values[':registryKey'];
        items = items.filter((item) => item.gsi3pk === gsi3pk);
        const gsi3sk = values[':unitId'];
        if (typeof gsi3sk === 'string') {
          items = items.filter((item) => item.gsi3sk === gsi3sk);
        }
      } else if (typeof values[':pk'] === 'string') {
        items = items.filter((item) => item.pk === values[':pk']);
        const prefix = values[':prefix'];
        if (typeof prefix === 'string') {
          items = items.filter((item) => typeof item.sk === 'string' && item.sk.startsWith(prefix));
        }
      }
      return Promise.resolve({ Items: items });
    }

    if (name === 'TransactWriteCommand') {
      const items = (input.TransactItems ?? []) as readonly TransactItem[];
      const reasons: string[] = [];
      let anyFailed = false;

      for (const item of items) {
        if (item.ConditionCheck) {
          const { Key, ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames } =
            item.ConditionCheck;
          const ok = evaluateCondition(
            ConditionExpression,
            store.get(itemKey(Key)),
            ExpressionAttributeValues ?? {},
            ExpressionAttributeNames ?? {},
          );
          reasons.push(ok ? 'None' : 'ConditionalCheckFailed');
          if (!ok) anyFailed = true;
        } else if (item.Update) {
          const { Key, ConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames } =
            item.Update;
          const ok =
            !ConditionExpression ||
            evaluateCondition(
              ConditionExpression,
              store.get(itemKey(Key)),
              ExpressionAttributeValues ?? {},
              ExpressionAttributeNames ?? {},
            );
          reasons.push(ok ? 'None' : 'ConditionalCheckFailed');
          if (!ok) anyFailed = true;
        } else if (item.Put) {
          const ok = evaluateCondition(
            'attribute_not_exists(pk)',
            store.get(itemKey(item.Put.Item)),
            {},
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

    return Promise.reject(
      new Error(`ridingBoard testDynamoFake does not support command: ${name}`),
    );
  };

  const peek = (partitionKey: string, sortKey: string): FakeItem | undefined =>
    store.get(`${partitionKey}#${sortKey}`);
  const put = (item: FakeItem): void => {
    store.set(itemKey(item), item);
  };

  return { send, peek, put } as unknown as FakeDocumentClient;
}

export { ConditionalCheckFailedException };
