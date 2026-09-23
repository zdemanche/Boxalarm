import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('readInspectionsConfig', () => {
  it('throws naming the missing env var when PLATFORM_TABLE_NAME is unset', async () => {
    const { readInspectionsConfig } = await import('./dynamoClient.js');
    expect(() => readInspectionsConfig({})).toThrow('PLATFORM_TABLE_NAME');
  });

  it('returns the table name when PLATFORM_TABLE_NAME is set', async () => {
    const { readInspectionsConfig } = await import('./dynamoClient.js');
    expect(readInspectionsConfig({ PLATFORM_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
  });
});

describe('getDocumentClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('caches and returns the injected client across calls', async () => {
    const { getDocumentClient } = await import('./dynamoClient.js');
    const fake = { send: vi.fn() } as unknown as DynamoDBDocumentClient;

    expect(getDocumentClient(fake)).toBe(fake);
    expect(getDocumentClient()).toBe(fake);
  });
});
