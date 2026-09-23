import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readNotificationConfig', () => {
  it('reads the shared platform-service table name', async () => {
    const { readNotificationConfig } = await import('./dynamoClient.js');
    expect(readNotificationConfig({ PLATFORM_SERVICE_TABLE_NAME: 'platform-service' })).toEqual({
      tableName: 'platform-service',
    });
  });

  it('throws when PLATFORM_SERVICE_TABLE_NAME is missing', async () => {
    const { readNotificationConfig } = await import('./dynamoClient.js');
    expect(() => readNotificationConfig({})).toThrow(
      'PLATFORM_SERVICE_TABLE_NAME is required and was not set',
    );
  });
});

describe('createDynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.PLATFORM_SERVICE_TABLE_NAME;
    const { createDynamoClient } = await import('./dynamoClient.js');
    expect(() => createDynamoClient(process.env)).toThrow(
      'PLATFORM_SERVICE_TABLE_NAME is required',
    );
  });

  it('memoizes the client across calls, ignoring a later override once cached', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const injected = {} as unknown as DynamoDBDocumentClient;
    const other = {} as unknown as DynamoDBDocumentClient;

    const first = createDynamoClient(process.env, injected);
    const second = createDynamoClient(process.env, other);

    expect(first).toBe(injected);
    expect(second).toBe(injected);
  });

  it('constructs a real X-Ray-wrapped DynamoDBDocumentClient when none is injected', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const client = createDynamoClient(process.env);
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
