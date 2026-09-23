import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const fakeContext = {} as unknown as Context;

describe('personnel-service health handlers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('liveness returns 200 unconditionally, with no dependency check', async () => {
    const { livenessHandler } = await import('./health.js');
    const result = await livenessHandler(undefined, fakeContext, () => undefined);
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('readiness returns 200 when DynamoDB is reachable', async () => {
    const { createReadinessHandler } = await import('./health.js');
    const send = vi.fn().mockResolvedValue({});
    const readiness = createReadinessHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    const result = await readiness(undefined, fakeContext, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('readiness returns 503 when DynamoDB is unreachable (hard dependency)', async () => {
    const { createReadinessHandler } = await import('./health.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('table unreachable'));
    const readiness = createReadinessHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
    });

    const result = await readiness(undefined, fakeContext, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('exercises the exported readiness handler (entrypoint test)', async () => {
    const { readinessHandler } = await import('./health.js');
    expect(typeof readinessHandler).toBe('function');
  });
});
