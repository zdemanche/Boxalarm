import { describe, expect, it } from 'vitest';
import { readPlatformTableConfig } from './config.js';

describe('readPlatformTableConfig', () => {
  it('reads the table name', () => {
    expect(readPlatformTableConfig({ PLATFORM_TABLE_NAME: 'platform-service' })).toEqual({
      tableName: 'platform-service',
    });
  });

  it('throws (fail-closed) when PLATFORM_TABLE_NAME is missing (empty/absent-input row)', () => {
    expect(() => readPlatformTableConfig({})).toThrow('PLATFORM_TABLE_NAME is required');
  });
});
