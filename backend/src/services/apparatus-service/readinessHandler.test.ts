import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('readinessHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./client.js');
  });

  it('returns 200 when DynamoDB is reachable', async () => {
    vi.doMock('./client.js', () => ({
      createDynamoClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
      readApparatusConfig: vi.fn(() => ({ tableName: 'platform-table' })),
    }));

    const { handler } = await import('./readinessHandler.js');
    const result = await handler();

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503 and logs the original error when DynamoDB is unreachable (fail-closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('./client.js', () => ({
      createDynamoClient: vi.fn(() => ({
        send: vi.fn().mockRejectedValue(new Error('table unavailable')),
      })),
      readApparatusConfig: vi.fn(() => ({ tableName: 'platform-table' })),
    }));

    const { handler } = await import('./readinessHandler.js');
    const result = await handler();

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('apparatus.readiness.failed'));
    errorSpy.mockRestore();
  });
});
