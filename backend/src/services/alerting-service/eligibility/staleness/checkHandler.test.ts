import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
  process.env.DEPT_ID = 'NICHOLS';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function snapshotItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: 'MEMBER#mbr-1',
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId: 'mbr-1',
    active: true,
    quals: [],
    roles: [],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: Date.now(),
    ...overrides,
  };
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

describe('eligibility staleness check (SNAP-STALE, 15-minute regression)', () => {
  it('emits SnapshotStale=0 when every snapshot updated within the last 15 minutes', async () => {
    mockDdb(vi.fn().mockResolvedValue({ Items: [snapshotItem()] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result).toEqual({ staleCount: 0, totalCount: 1 });
    const metricLine = logSpy.mock.calls.find((call) =>
      (call[0] as string).includes('SnapshotStale'),
    );
    const parsed = JSON.parse(metricLine?.[0] as string) as { SnapshotStale: number };
    expect(parsed.SnapshotStale).toBe(0);
    logSpy.mockRestore();
  });

  it('counts a snapshot last updated more than 15 minutes ago as stale', async () => {
    const staleUpdatedAt = Date.now() - 16 * 60 * 1000;
    mockDdb(
      vi.fn().mockResolvedValue({ Items: [snapshotItem({ snapshotUpdatedAt: staleUpdatedAt })] }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result).toEqual({ staleCount: 1, totalCount: 1 });
    logSpy.mockRestore();
  });

  it('does not count a snapshot updated exactly at the 14-minute mark as stale (boundary)', async () => {
    mockDdb(
      vi.fn().mockResolvedValue({
        Items: [snapshotItem({ snapshotUpdatedAt: Date.now() - 14 * 60 * 1000 })],
      }),
    );
    const { handler } = await import('./checkHandler.js');
    const result = await handler();
    expect(result.staleCount).toBe(0);
  });

  it('rethrows on a DynamoDB read failure', async () => {
    mockDdb(vi.fn().mockRejectedValue(new Error('query failed')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');
    await expect(handler()).rejects.toThrow('query failed');
    errorSpy.mockRestore();
  });
});
