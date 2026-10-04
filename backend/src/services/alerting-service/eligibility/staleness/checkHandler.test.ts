import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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

function snapshotItem(
  memberId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: `MEMBER#${memberId}`,
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId,
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
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

function metricValue(logSpy: MockInstance<typeof console.log>, metricName: string): number {
  const line = logSpy.mock.calls.find((call) => (call[0] as string).includes(metricName));
  const parsed = JSON.parse(line?.[0] as string) as Record<string, number>;
  return parsed[metricName] as number;
}

describe('eligibility staleness check (#232: propagation lag, not absolute write age)', () => {
  it('emits SnapshotStale=0 when every snapshot updated within the last 15 minutes', async () => {
    mockDdb(vi.fn().mockResolvedValue({ Items: [snapshotItem('mbr-1')] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result.staleCount).toBe(0);
    expect(result.totalCount).toBe(1);
    expect(metricValue(logSpy, 'SnapshotStale')).toBe(0);
    logSpy.mockRestore();
  });

  it('#232 regression: an idle member untouched for 20 minutes is NOT stale when another member updated seconds ago', async () => {
    const idleMemberUpdatedAt = Date.now() - 20 * 60 * 1000;
    const freshMemberUpdatedAt = Date.now() - 1000;
    mockDdb(
      vi.fn().mockResolvedValue({
        Items: [
          snapshotItem('idle-member', { snapshotUpdatedAt: idleMemberUpdatedAt }),
          snapshotItem('fresh-member', { snapshotUpdatedAt: freshMemberUpdatedAt }),
        ],
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result.staleCount).toBe(0);
    expect(result.totalCount).toBe(2);
    expect(result.propagationLagMs).toBeLessThan(15 * 60 * 1000);
    expect(metricValue(logSpy, 'SnapshotStale')).toBe(0);
    logSpy.mockRestore();
  });

  it('is stale when the whole department has no snapshot write in over 15 minutes', async () => {
    const staleUpdatedAt = Date.now() - 16 * 60 * 1000;
    mockDdb(
      vi.fn().mockResolvedValue({
        Items: [
          snapshotItem('mbr-1', { snapshotUpdatedAt: staleUpdatedAt }),
          snapshotItem('mbr-2', { snapshotUpdatedAt: staleUpdatedAt - 60_000 }),
        ],
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result.staleCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(metricValue(logSpy, 'SnapshotStale')).toBe(1);
    logSpy.mockRestore();
  });

  it('does not flag staleness when the most recent write is exactly at the 14-minute mark (boundary)', async () => {
    mockDdb(
      vi.fn().mockResolvedValue({
        Items: [snapshotItem('mbr-1', { snapshotUpdatedAt: Date.now() - 14 * 60 * 1000 })],
      }),
    );
    const { handler } = await import('./checkHandler.js');
    const result = await handler();
    expect(result.staleCount).toBe(0);
  });

  it('reports zero lag and not-stale for a department with zero eligible members', async () => {
    mockDdb(vi.fn().mockResolvedValue({ Items: [] }));
    const { handler } = await import('./checkHandler.js');

    const result = await handler();

    expect(result).toEqual({ staleCount: 0, totalCount: 0, propagationLagMs: 0 });
  });

  it('emits to the Boxalarm/AlertingEligibility namespace (matching memberUpdatedHandler.ts)', async () => {
    mockDdb(vi.fn().mockResolvedValue({ Items: [snapshotItem('mbr-1')] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');

    await handler();

    const line = logSpy.mock.calls.find((call) => (call[0] as string).includes('SnapshotStale'));
    const parsed = JSON.parse(line?.[0] as string) as {
      _aws: { CloudWatchMetrics: Array<{ Namespace: string }> };
    };
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/AlertingEligibility');
    logSpy.mockRestore();
  });

  it('rethrows on a DynamoDB read failure', async () => {
    mockDdb(vi.fn().mockRejectedValue(new Error('query failed')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./checkHandler.js');
    await expect(handler()).rejects.toThrow('query failed');
    errorSpy.mockRestore();
  });
});
