import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('readPersonnelTableConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when PERSONNEL_TABLE_NAME is unset', async () => {
    delete process.env.PERSONNEL_TABLE_NAME;
    const { readPersonnelTableConfig } = await import('./dynamoClient.js');
    expect(() => readPersonnelTableConfig(process.env)).toThrow(
      'PERSONNEL_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when set', async () => {
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
    const { readPersonnelTableConfig } = await import('./dynamoClient.js');
    expect(readPersonnelTableConfig(process.env)).toEqual({ tableName: 'personnel-table' });
  });
});
