import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('livenessHandler', () => {
  it('returns 200 unconditionally (process alive, no dependency check)', async () => {
    const { livenessHandler } = await import('./healthHandler.js');
    const result = await livenessHandler();
    expect(result).toMatchObject({ statusCode: 200 });
  });
});

describe('readiness (createReadinessHandler)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 when the DynamoDB DescribeTable ping succeeds (readiness-both-ways: success)', async () => {
    const { createReadinessHandler } = await import('./healthHandler.js');
    const client = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const readiness = createReadinessHandler(client);

    const result = await readiness();

    expect(result).toMatchObject({ statusCode: 200 });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` usage
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('returns 503, logging the original error, when DynamoDB is unavailable — fail closed (readiness-both-ways: failure)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createReadinessHandler } = await import('./healthHandler.js');
    const client = {
      send: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
    } as unknown as DynamoDBDocumentClient;
    const readiness = createReadinessHandler(client);

    const result = await readiness();

    expect(result).toMatchObject({ statusCode: 503 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain('DynamoDB unavailable');
    logSpy.mockRestore();
  });

  it('returns 503 (fail-closed) without pinging DynamoDB when PLATFORM_SERVICE_TABLE_NAME is missing', async () => {
    delete process.env.PLATFORM_SERVICE_TABLE_NAME;
    const { createReadinessHandler } = await import('./healthHandler.js');
    const client = { send: vi.fn() } as unknown as DynamoDBDocumentClient;
    const readiness = createReadinessHandler(client);

    const result = await readiness();

    expect(result).toMatchObject({ statusCode: 503 });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` usage
    expect(client.send).not.toHaveBeenCalled();
  });
});
