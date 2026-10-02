import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('CAD update sweep (notifier gap)', () => {
  const originalEnv = { ...process.env };
  const NOW = 1_800_001_000;
  let notified: unknown[];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    process.env.ALERTING_TABLE_NAME = 'alerting';
    process.env.CAD_SWEEP_DEPT_ID = 'nichols-fd';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    notified = [];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function run(items: Record<string, unknown>[]) {
    const send = vi.fn().mockResolvedValue({ Items: items });
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
    }));
    vi.doMock('./notifyUpdate.js', () => ({
      notifyUpdate: (notice: unknown) => {
        notified.push(notice);
        return Promise.resolve();
      },
    }));
    const { handler } = await import('./updateSweepHandler.js');
    return { result: await handler(), send };
  }

  it('re-drives every pending update older than 2 minutes and counts those older than 10 as unnotified', async () => {
    const { result, send } = await run([
      { dispatchId: 'd-1', updateId: 'u1', receivedAt: NOW - 700 },
      { dispatchId: 'd-2', updateId: 'u2', receivedAt: NOW - 200 },
    ]);
    expect(result).toEqual({ pending: 2, stale: 1 });
    expect(notified).toEqual([
      { deptId: 'nichols-fd', dispatchId: 'd-1', updateId: 'u1' },
      { deptId: 'nichols-fd', dispatchId: 'd-2', updateId: 'u2' },
    ]);
    const query = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(query.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#nichols-fd#CAD_UPDATE_PENDING',
      ':cutoff': String(NOW - 120).padStart(12, '0'),
    });
    const logged = vi.mocked(console.log).mock.calls.map(([l]) => String(l));
    expect(logged.filter((l) => l.includes('"CadUpdateUnnotified":1'))).toHaveLength(1);
  });

  it('is quiet when nothing is pending', async () => {
    expect((await run([])).result).toEqual({ pending: 0, stale: 0 });
    expect(notified).toEqual([]);
  });
});
