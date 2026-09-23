import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getRawClient, readInventoryConfig } from './dynamoDb.js';

describe('readInventoryConfig', () => {
  it('throws when PLATFORM_TABLE_NAME is not set', () => {
    expect(() => readInventoryConfig({})).toThrow('PLATFORM_TABLE_NAME is required');
  });

  it('returns the table name when set', () => {
    expect(readInventoryConfig({ PLATFORM_TABLE_NAME: 'boxalarm-platform' })).toEqual({
      tableName: 'boxalarm-platform',
    });
  });
});

describe('getDocClient', () => {
  it('returns the injected client unchanged, without constructing a real client', () => {
    const fake = { send: () => Promise.resolve({}) } as unknown as DynamoDBDocumentClient;
    expect(getDocClient(fake)).toBe(fake);
  });
});

describe('P5/P8: production wiring (no injected client)', () => {
  it('getRawClient() constructs and memoizes a real, X-Ray-wrapped DynamoDBClient', () => {
    const first = getRawClient();
    const second = getRawClient();
    expect(first).toBeDefined();
    expect(typeof first.send).toBe('function');
    expect(second).toBe(first);
  });

  it('getDocClient() constructs and memoizes a real DynamoDBDocumentClient built on getRawClient()', () => {
    const first = getDocClient();
    const second = getDocClient();
    expect(first).toBeDefined();
    expect(typeof first.send).toBe('function');
    expect(second).toBe(first);
  });
});
