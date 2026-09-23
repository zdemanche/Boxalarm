import { describe, expect, it } from 'vitest';
import { getDynamoClient, readDispatchesConfig } from './dynamoClient.js';

describe('readDispatchesConfig', () => {
  it('reads the table name from ALERTING_DISPATCHES_TABLE_NAME', () => {
    const config = readDispatchesConfig({ ALERTING_DISPATCHES_TABLE_NAME: 'alerting-table' });
    expect(config).toEqual({ tableName: 'alerting-table' });
  });

  it('fails fast when ALERTING_DISPATCHES_TABLE_NAME is not set', () => {
    expect(() => readDispatchesConfig({})).toThrow('ALERTING_DISPATCHES_TABLE_NAME');
  });
});

describe('getDynamoClient', () => {
  it('memoizes the same client instance across calls (cold-start factory pattern)', () => {
    expect(getDynamoClient()).toBe(getDynamoClient());
  });
});
