import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';

describe('dynamoClient', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws a fail-closed error when PLATFORM_TABLE_NAME is unset', () => {
    delete process.env.PLATFORM_TABLE_NAME;
    expect(() => readPersonnelTableConfig(process.env)).toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('returns the configured table name when PLATFORM_TABLE_NAME is set', () => {
    expect(readPersonnelTableConfig(process.env)).toEqual({ tableName: 'platform-service' });
  });

  it('returns a memoized, real DynamoDBDocumentClient', () => {
    const client = getDocClient(process.env);
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
    expect(getDocClient(process.env)).toBe(client);
  });
});
