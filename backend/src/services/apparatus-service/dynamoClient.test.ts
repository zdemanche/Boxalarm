import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readApparatusServiceConfig', () => {
  it('reads the table name', async () => {
    const { readApparatusServiceConfig } = await import('./dynamoClient.js');
    expect(readApparatusServiceConfig({ PLATFORM_TABLE_NAME: 'platform-service' })).toEqual({
      tableName: 'platform-service',
    });
  });

  it('throws when PLATFORM_TABLE_NAME is missing (empty/absent-input row)', async () => {
    const { readApparatusServiceConfig } = await import('./dynamoClient.js');
    expect(() => readApparatusServiceConfig({})).toThrow('PLATFORM_TABLE_NAME is required');
  });
});

describe('createDynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws (fail-closed) instead of returning a client when config is missing', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createDynamoClient } = await import('./dynamoClient.js');
    expect(() => createDynamoClient(process.env)).toThrow('PLATFORM_TABLE_NAME is required');
  });

  it('constructs a client once and reuses the same instance across calls', async () => {
    const { createDynamoClient } = await import('./dynamoClient.js');
    const fakeClient = {} as DynamoDBDocumentClient;
    const first = createDynamoClient(process.env, fakeClient);
    const second = createDynamoClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });
});
