import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readMapTableConfig } from './dynamoClient.js';

describe('readMapTableConfig', () => {
  it('throws when PLATFORM_TABLE_NAME is not set (config guard, P6)', () => {
    expect(() => readMapTableConfig({})).toThrow('PLATFORM_TABLE_NAME is required and was not set');
  });

  it('returns the configured table name', () => {
    expect(readMapTableConfig({ PLATFORM_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
  });
});

describe('createDynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when PLATFORM_TABLE_NAME is not set, before constructing a client (config guard, P6)', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const { createDynamoClient: createClient } = await import('./dynamoClient.js');
    expect(() => createClient({})).toThrow('PLATFORM_TABLE_NAME is required and was not set');
  });

  it('constructs a client once and reuses the same instance across calls (P5)', async () => {
    const { createDynamoClient: createClient } = await import('./dynamoClient.js');
    const fakeClient = {} as DynamoDBDocumentClient;
    const first = createClient(process.env, fakeClient);
    const second = createClient(process.env);
    expect(first).toBe(fakeClient);
    expect(second).toBe(fakeClient);
  });
});
