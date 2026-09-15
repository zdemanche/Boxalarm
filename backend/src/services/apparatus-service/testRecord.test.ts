import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildTestRecordItem, parseTestRecordItem } from './testRecord.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

describe('buildTestRecordItem', () => {
  it('writes the TEST#{testType}#{testDate} sort key and DUE#APPARATUS_TEST GSI2 shape (AC1)', () => {
    const item = buildTestRecordItem(DEPT_ID, 'APP-ENGINE-2', {
      testType: 'HOSE',
      testDate: '2026-05-01',
      result: 'PASS',
      nextDueDate: '2027-05-01',
    });

    expect(item.pk).toBe('DEPT#dept-001#APPARATUS#APP-ENGINE-2');
    expect(item.sk).toBe('TEST#HOSE#2026-05-01');
    expect(item.entityType).toBe('APPARATUS_TEST_RECORD');
    expect(item.gsi2pk).toBe('DEPT#dept-001#DUE#APPARATUS_TEST#2027-05');
    expect(item.gsi2sk).toBe('2027-05-01#APP-ENGINE-2#HOSE');
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

    const itemA = buildTestRecordItem(deptA, 'ENGINE-2', input);
    const itemB = buildTestRecordItem(deptB, 'ENGINE-2', input);

    expect(itemA.pk).not.toBe(itemB.pk);
    expect(itemA.gsi2pk).not.toBe(itemB.gsi2pk);
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
