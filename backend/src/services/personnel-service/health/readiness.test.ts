import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('handler', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    vi.doUnmock('../dynamoClient.js');
    delete process.env.PLATFORM_SERVICE_TABLE_NAME;
  });

  it('returns 200 when DynamoDB is reachable', async () => {
    vi.doMock('../dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => ({ send: vi.fn().mockResolvedValue({}) }) };
    });
    const { handler } = await import('./readiness.js');
    const result = (await handler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(200);
  });

  it('returns 503 when DynamoDB is unreachable', async () => {
    vi.doMock('../dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({
          send: vi.fn().mockRejectedValue(new Error('table not found')),
        }),
      };
    });
    const { handler } = await import('./readiness.js');
    const result = (await handler({} as never, {} as never, () => undefined)) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(503);
  });
});
