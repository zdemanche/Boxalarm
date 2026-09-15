import { describe, expect, it } from 'vitest';
import { readOccupancyAuthorizationConfig, readOccupancyServiceConfig } from './config.js';

describe('readOccupancyServiceConfig', () => {
  it('throws when OCCUPANCY_TABLE_NAME is not set', () => {
    expect(() => readOccupancyServiceConfig({})).toThrow(
      'OCCUPANCY_TABLE_NAME is required and was not set',
    );
  });

  it('returns the table name when set', () => {
    expect(readOccupancyServiceConfig({ OCCUPANCY_TABLE_NAME: 'boxalarm-platform-table' })).toEqual(
      { tableName: 'boxalarm-platform-table' },
    );
  });
});

describe('readOccupancyAuthorizationConfig', () => {
  it('throws when VERIFIED_PERMISSIONS_POLICY_STORE_ID is not set', () => {
    expect(() => readOccupancyAuthorizationConfig({})).toThrow(
      'VERIFIED_PERMISSIONS_POLICY_STORE_ID is required and was not set',
    );
  });

  it('returns the policy store id when set', () => {
    expect(
      readOccupancyAuthorizationConfig({ VERIFIED_PERMISSIONS_POLICY_STORE_ID: 'PSEXAMPLE1' }),
    ).toEqual({ policyStoreId: 'PSEXAMPLE1' });
  });
});
