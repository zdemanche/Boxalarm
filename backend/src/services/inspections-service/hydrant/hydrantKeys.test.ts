import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  HYDRANT_SK,
  buildHydrantDueGsi2Pk,
  buildHydrantGsi2Keys,
  buildHydrantGsi3Keys,
  isValidCalendarDate,
} from './hydrantKeys.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('HYDRANT_SK', () => {
  it('is the fixed METADATA sort key', () => {
    expect(HYDRANT_SK).toBe('METADATA');
  });
});

describe('buildHydrantGsi2Keys (AC1, AC4)', () => {
  it('derives the month-bucketed gsi2pk and dueDate-ordered gsi2sk', () => {
    const keys = buildHydrantGsi2Keys(deptId, '2027-01-10', 'HYD-0231');
    expect(keys.gsi2pk).toBe('DEPT#NICHOLS#DUE#HYDRANT#2027-01');
    expect(keys.gsi2sk).toBe('2027-01-10#HYD-0231');
  });

  it('rejects a non-ISO nextFlowTestDue (core-harm: a malformed due date silently breaks scheduling)', () => {
    expect(() => buildHydrantGsi2Keys(deptId, '01/10/2027', 'HYD-0231')).toThrow(/ISO date/);
  });

  it('rejects a shape-valid but calendar-invalid nextFlowTestDue (core-harm: month 13 drops the hydrant out of scheduling)', () => {
    expect(() => buildHydrantGsi2Keys(deptId, '2027-13-45', 'HYD-0231')).toThrow(/calendar/);
  });
});

describe('isValidCalendarDate', () => {
  it('accepts a real calendar date', () => {
    expect(isValidCalendarDate('2027-02-28')).toBe(true);
  });

  it('rejects a shape-valid but out-of-range calendar date', () => {
    expect(isValidCalendarDate('2027-02-30')).toBe(false);
    expect(isValidCalendarDate('2027-13-45')).toBe(false);
    expect(isValidCalendarDate('0000-00-00')).toBe(false);
  });
});

describe('buildHydrantDueGsi2Pk (AC4 due-within-window query)', () => {
  it('matches the pk buildHydrantGsi2Keys derives for the same month', () => {
    const { gsi2pk } = buildHydrantGsi2Keys(deptId, '2027-01-10', 'HYD-0231');
    expect(buildHydrantDueGsi2Pk(deptId, '2027-01')).toBe(gsi2pk);
  });
});

describe('buildHydrantGsi3Keys (AC1 map retrieval)', () => {
  it('encodes an 8-char geohash sort key sharing its 5-char prefix with the partition key', () => {
    const keys = buildHydrantGsi3Keys(deptId, 41.2417, -73.2004, 'HYD-0231');
    expect(keys.gsi3pk).toMatch(/^DEPT#NICHOLS#HYDRANT#GEO#[0-9b-hj-km-np-z]{5}$/);
    expect(keys.gsi3sk).toMatch(/^[0-9b-hj-km-np-z]{8}#HYD-0231$/);
    const prefix = keys.gsi3pk.split('GEO#')[1];
    expect(keys.gsi3sk.startsWith(prefix ?? '')).toBe(true);
  });

  it('is deterministic for the same coordinates', () => {
    const first = buildHydrantGsi3Keys(deptId, 41.2417, -73.2004, 'HYD-0231');
    const second = buildHydrantGsi3Keys(deptId, 41.2417, -73.2004, 'HYD-0231');
    expect(first).toEqual(second);
  });

  it('rejects an out-of-range latitude', () => {
    expect(() => buildHydrantGsi3Keys(deptId, 91, 0, 'HYD-0231')).toThrow(/latitude/);
  });

  it('rejects a NaN longitude (routine input domain: string-for-number coercion)', () => {
    expect(() => buildHydrantGsi3Keys(deptId, 0, Number.NaN, 'HYD-0231')).toThrow(/longitude/);
  });
});
