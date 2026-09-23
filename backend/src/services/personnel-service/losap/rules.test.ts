import { describe, expect, it } from 'vitest';
import { computeLosapPoints, isValidLosapPointRules } from './rules.js';

const ACTIVITY_TYPES = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'] as const;

describe('computeLosapPoints', () => {
  it('returns the configured points for a rule-covered activityType', () => {
    expect(computeLosapPoints('CALL', { CALL: 2, DRILL: 1 })).toBe(2);
  });

  it('returns 0 when the activityType has no entry in the rules', () => {
    expect(computeLosapPoints('MEETING', { CALL: 2 })).toBe(0);
  });

  it('returns 0 when the rules map is empty', () => {
    expect(computeLosapPoints('CALL', {})).toBe(0);
  });
});

describe('isValidLosapPointRules', () => {
  it('accepts a map of known activity types to non-negative numbers', () => {
    expect(isValidLosapPointRules({ CALL: 2, DRILL: 1.5, STANDBY: 0 }, ACTIVITY_TYPES)).toBe(true);
  });

  it('rejects an empty object', () => {
    expect(isValidLosapPointRules({}, ACTIVITY_TYPES)).toBe(false);
  });

  it('rejects an unknown activityType key', () => {
    expect(isValidLosapPointRules({ BBQ: 1 }, ACTIVITY_TYPES)).toBe(false);
  });

  it('rejects a negative point value', () => {
    expect(isValidLosapPointRules({ CALL: -1 }, ACTIVITY_TYPES)).toBe(false);
  });

  it('rejects a non-numeric point value', () => {
    expect(isValidLosapPointRules({ CALL: '2' }, ACTIVITY_TYPES)).toBe(false);
  });

  it('rejects null, arrays, and non-objects', () => {
    expect(isValidLosapPointRules(null, ACTIVITY_TYPES)).toBe(false);
    expect(isValidLosapPointRules(['CALL'], ACTIVITY_TYPES)).toBe(false);
    expect(isValidLosapPointRules('CALL', ACTIVITY_TYPES)).toBe(false);
  });
});
