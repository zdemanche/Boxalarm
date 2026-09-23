import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('alerting-service health handlers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
  });

  it('liveness always returns 200', async () => {
    const { liveness } = await import('./handler.js');
    const result = (await liveness()) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'alive' });
  });

  it('readiness returns 200 when DynamoDB responds', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: vi.fn().mockResolvedValue({}) }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { readiness } = await import('./handler.js');
    const result = (await readiness()) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'ready' });
  });

  it('readiness returns 503 when DynamoDB is unreachable — the alerting isolation invariant means this readiness check hits only the alerting table, never platform-service', async () => {
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: vi.fn().mockRejectedValue(new Error('outage')) }),
      readAlertingConfig: () => ({ tableName: 'alerting-table' }),
    }));
    const { readiness } = await import('./handler.js');
    const result = (await readiness()) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ status: 'not-ready' });
  });
});
