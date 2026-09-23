import { describe, expect, it } from 'vitest';
import { readPersonnelConfig } from './config.js';

describe('readPersonnelConfig', () => {
  it('reads PERSONNEL_TABLE_NAME', () => {
    expect(readPersonnelConfig({ PERSONNEL_TABLE_NAME: 'boxalarm-dev-platform' })).toEqual({
      tableName: 'boxalarm-dev-platform',
    });
  });

  it('throws when PERSONNEL_TABLE_NAME is missing (fail-closed)', () => {
    expect(() => readPersonnelConfig({})).toThrow('PERSONNEL_TABLE_NAME is required');
  });

  it('throws when PERSONNEL_TABLE_NAME is empty', () => {
    expect(() => readPersonnelConfig({ PERSONNEL_TABLE_NAME: '' })).toThrow(
      'PERSONNEL_TABLE_NAME is required',
    );
  });
});
