import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

vi.mock('../eligibility/dynamoClient.js', () => ({
  createDynamoClient: vi.fn(),
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
}));

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(seed: readonly FakeItem[] = []): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (put.ConditionExpression && items.has(key)) {
        const existing = items.get(key);
        if (
          put.ConditionExpression.includes('expiresAt') &&
          typeof existing?.expiresAt === 'number' &&
          existing.expiresAt <
            ((input as { ExpressionAttributeValues?: Record<string, unknown> })
              .ExpressionAttributeValues?.[':now'] as number)
        ) {
          items.set(key, put.Item);
          return Promise.resolve({});
        }
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, put.Item);
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(idempotencyKey)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        (error as unknown as { CancellationReasons: { Code: string }[] }).CancellationReasons =
          transactItems.map((_, i) => ({
            Code: i === failedIndex ? 'ConditionalCheckFailed' : 'None',
          }));
        throw error;
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, items };
}

describe('canary handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.CANARY_DEPT_ID = 'NICHOLS';
    process.env.CANARY_MEMBER_ID = 'canary-device';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('starts a new self-test run addressed to the canary member and records a pointer for next time', async () => {
    const { send, items } = createFakeDdb();
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const pointer = items.get('DEPT#NICHOLS#CANARY#STATE');
    expect(pointer).toBeDefined();
    expect(typeof pointer?.pendingTestId).toBe('string');
    const run = [...items.values()].find((item) => item.entityType === 'SELF_TEST_RUN');
    expect(run).toMatchObject({ memberId: 'canary-device', overallResult: 'RUNNING' });
  });

  it('completes a pending run as PASS when the self-test finished within the latency budget, and records a CANARY_RUN (AC1)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { send, items } = createFakeDdb([
      { pk: 'DEPT#NICHOLS#CANARY', sk: 'STATE', pendingTestId: 'canary-1', pendingRunAt: now - 2 },
      {
        pk: 'DEPT#NICHOLS#MEMBER#canary-device',
        sk: 'SELFTEST#canary-1',
        entityType: 'SELF_TEST_RUN',
        overallResult: 'PASS',
        channelResults: { PUSH: { ok: true, ms: 100 } },
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const canaryRun = [...items.values()].find((item) => item.entityType === 'CANARY_RUN');
    expect(canaryRun).toMatchObject({ result: 'PASS', testId: 'canary-1' });
  });

  it('marks the run FAIL when the self-test never completed (AC2: pages on-call, not silently blinded)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { send, items } = createFakeDdb([
      { pk: 'DEPT#NICHOLS#CANARY', sk: 'STATE', pendingTestId: 'canary-1', pendingRunAt: now - 2 },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const canaryRun = [...items.values()].find((item) => item.entityType === 'CANARY_RUN');
    expect(canaryRun).toMatchObject({ result: 'FAIL', testId: 'canary-1' });
  });
});
