import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

function fakeDynamoClient(send: () => Promise<unknown>): DynamoDBClient {
  return { send: vi.fn(send) } as unknown as DynamoDBClient;
}

describe('inventory health handlers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('liveness always returns 200 with no dependency check (entrypoint)', async () => {
    const { livenessHandler } = await import('./handler.js');

    const result = await livenessHandler({} as never, {} as never, {} as never);

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('readiness returns 200 when DynamoDB DescribeTable succeeds', async () => {
    const { createReadinessHandler } = await import('./handler.js');
    const readiness = createReadinessHandler(fakeDynamoClient(() => Promise.resolve({})));

    const result = await readiness({} as never, {} as never, {} as never);

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('readiness returns 503, not a crash, when DynamoDB DescribeTable fails (entrypoint, fail-closed)', async () => {
    const { createReadinessHandler, readinessHandler } = await import('./handler.js');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readiness = createReadinessHandler(
      fakeDynamoClient(() => {
        throw new Error('ResourceNotFoundException');
      }),
    );

    const result = await readiness({} as never, {} as never, {} as never);

    expect(result).toMatchObject({ statusCode: 503 });
    expect(typeof readinessHandler).toBe('function');
    logSpy.mockRestore();
  });
});
