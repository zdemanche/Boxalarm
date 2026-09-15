import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const noopCallback = (() => undefined) as never;

describe('liveness', () => {
  it('always returns 200 with no dependency checks (exported handler)', async () => {
    const { liveness } = await import('./handler.js');
    const result = await liveness({}, {} as never, noopCallback);
    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(String(result?.body))).toEqual({ status: 'ok' });
  });
});

describe('readiness', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
    process.env.TRAINING_DYNAMO_TABLE_NAME = 'training-table';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 200 when DynamoDB is reachable (readiness success)', async () => {
    const { createReadinessHandler } = await import('./handler.js');
    const fakeClient = { send: vi.fn().mockResolvedValue({}) } as unknown as DynamoDBDocumentClient;
    const handler = createReadinessHandler(() => fakeClient);

    const result = await handler({}, {} as never, noopCallback);

    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(String(result?.body))).toEqual({ status: 'ok' });
  });

  it('returns 503 when DynamoDB is unavailable (readiness failure, fail-closed)', async () => {
    const { createReadinessHandler } = await import('./handler.js');
    const fakeClient = {
      send: vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException')),
    } as unknown as DynamoDBDocumentClient;
    const handler = createReadinessHandler(() => fakeClient);

    const result = await handler({}, {} as never, noopCallback);

    expect(result?.statusCode).toBe(503);
    expect(JSON.parse(String(result?.body))).toEqual({ status: 'unavailable' });
  });

  it('returns 503 (real-deps default export) when required config is missing, never a silent 200 (entrypoint test)', async () => {
    delete process.env.PERSONNEL_TABLE_NAME;
    const { readiness } = await import('./handler.js');
    const result = await readiness({}, {} as never, noopCallback);
    expect(result?.statusCode).toBe(503);
  });
});
