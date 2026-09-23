import { describe, expect, it } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getDocumentClient, readHydrantTableConfig } from './dynamoClient.js';

describe('readHydrantTableConfig', () => {
  it('throws when PLATFORM_TABLE_NAME is not set', () => {
    expect(() => readHydrantTableConfig({})).toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when PLATFORM_TABLE_NAME is set', () => {
    expect(readHydrantTableConfig({ PLATFORM_TABLE_NAME: 'boxalarm-platform-table' })).toEqual({
      tableName: 'boxalarm-platform-table',
    });
  });
});

describe('getDocumentClient', () => {
  it('memoizes a single DynamoDBDocumentClient instance across calls', () => {
    const first = getDocumentClient();
    const second = getDocumentClient();
    expect(first).toBeInstanceOf(DynamoDBDocumentClient);
    expect(second).toBe(first);
  });
});
