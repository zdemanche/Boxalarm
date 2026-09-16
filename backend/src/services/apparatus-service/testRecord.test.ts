import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildTestDueItem,
  buildTestRecordItem,
  parseTestDueItem,
  parseTestRecordItem,
} from './testRecord.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

describe('buildTestRecordItem', () => {
  it('writes the TEST#{testType}#{testDate} sort key as a pure audit record with no GSI2 keys (AC1)', () => {
    const item = buildTestRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'HOSE',
      testDate: '2026-05-01',
      result: 'PASS',
      nextDueDate: '2027-05-01',
    });

    expect(item.pk).toBe('DEPT#dept-001#APPARATUS#APP-ENGINE-2');
    expect(item.sk).toBe('TEST#HOSE#2026-05-01');
    expect(item.entityType).toBe('APPARATUS_TEST_RECORD');
    expect(item.gsi2pk).toBeUndefined();
    expect(item.gsi2sk).toBeUndefined();
  });
});

describe('buildTestDueItem', () => {
  it('writes a single-valued-per-(apparatusId, testType) DUE item on a stable GSI2 partition (AC1)', () => {
    const item = buildTestDueItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'HOSE',
      testDate: '2026-05-01',
      result: 'PASS',
      nextDueDate: '2027-05-01',
    });

    expect(item.pk).toBe('DEPT#dept-001#APPARATUS#APP-ENGINE-2');
    expect(item.sk).toBe('DUE#HOSE');
    expect(item.entityType).toBe('APPARATUS_TEST_DUE');
    expect(item.gsi2pk).toBe('DEPT#dept-001#DUE#APPARATUS_TEST');
    expect(item.gsi2sk).toBe('2027-05-01#APP-ENGINE-2#HOSE');
  });

  it('overwrites the same pk/sk on a re-test, so the prior due date does not linger in GSI2 (regression coverage for the stale-entry bug)', () => {
    const first = buildTestDueItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'HOSE',
      testDate: '2026-05-01',
      result: 'PASS',
      nextDueDate: '2026-10-01',
    });
    const retested = buildTestDueItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'HOSE',
      testDate: '2026-09-20',
      result: 'PASS',
      nextDueDate: '2027-09-20',
    });

    expect(first.pk).toBe(retested.pk);
    expect(first.sk).toBe(retested.sk);
    expect(first.gsi2sk).not.toBe(retested.gsi2sk);
  });

  it('scopes different departments to different pk/gsi2pk for the same apparatus (core-harm)', () => {
    const deptA = toVerifiedDeptId({ deptId: 'dept-a' });
    const deptB = toVerifiedDeptId({ deptId: 'dept-b' });
    const input = {
      testType: 'LADDER' as const,
      testDate: '2026-05-01',
      result: 'PASS' as const,
      nextDueDate: '2027-05-01',
    };

    const itemA = buildTestDueItem(deptA, 'ENGINE-2', input);
    const itemB = buildTestDueItem(deptB, 'ENGINE-2', input);

    expect(itemA.pk).not.toBe(itemB.pk);
    expect(itemA.gsi2pk).not.toBe(itemB.gsi2pk);
  });
});

describe('parseTestDueItem', () => {
  it('round-trips a stored DUE item back into a TestDueEntry', () => {
    const item = buildTestDueItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'AERIAL',
      testDate: '2026-05-01',
      result: 'PASS',
      nextDueDate: '2027-05-01',
    });

    expect(parseTestDueItem(item)).toEqual({
      apparatusId: 'APP-ENGINE-2',
      testType: 'AERIAL',
      nextDueDate: '2027-05-01',
    });
  });
});

describe('parseTestRecordItem', () => {
  it('round-trips a stored item back into a TestRecord', () => {
    const item = buildTestRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'PUMP',
      testDate: '2026-05-01',
      result: 'FAIL',
      nextDueDate: '2027-05-01',
    });

    const record = parseTestRecordItem(item, 'APP-ENGINE-2', 'dept-001');

    expect(record).toEqual({
      apparatusId: 'APP-ENGINE-2',
      deptId: 'dept-001',
      testType: 'PUMP',
      testDate: '2026-05-01',
      result: 'FAIL',
      nextDueDate: '2027-05-01',
    });
  });
});
