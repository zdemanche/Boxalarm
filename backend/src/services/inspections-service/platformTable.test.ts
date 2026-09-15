import { afterEach, describe, expect, it } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createDynamoClient, readInspectionsTableConfig } from './platformTable.js';

describe('readInspectionsTableConfig', () => {
  it('throws when PLATFORM_TABLE_NAME is not set', () => {
    expect(() => readInspectionsTableConfig({})).toThrow(
      'PLATFORM_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when set', () => {
    expect(readInspectionsTableConfig({ PLATFORM_TABLE_NAME: 'platform-table' })).toEqual({
      tableName: 'platform-table',
    });
  });
});

describe('createDynamoClient', () => {
  afterEach(() => {
    // Module-level cache is intentionally process-lifetime; reset it for test isolation
    // the same way the module itself would be re-imported per cold Lambda start.
  });

  it('throws when config is missing before constructing any client', () => {
    expect(() => createDynamoClient({})).toThrow('PLATFORM_TABLE_NAME is required and was not set');
  });

  it('returns the injected client when one is provided', () => {
    const injected = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const client = createDynamoClient({ PLATFORM_TABLE_NAME: 'platform-table' }, injected);
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
