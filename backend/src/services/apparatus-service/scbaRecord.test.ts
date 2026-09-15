import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildScbaMetadataItem,
  buildScbaTestItem,
  computeNextFlowTestDue,
  computeNextHydroTestDue,
  parseScbaMetadataItem,
} from './scbaRecord.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

describe('computeNextFlowTestDue / computeNextHydroTestDue', () => {
  it('adds the flow-test interval (365 days) to the submitted date', () => {
    expect(computeNextFlowTestDue('2026-01-01')).toBe('2027-01-01');
  });

  it('adds the hydro-test interval (1825 days, spanning the 2028 leap year) to the submitted date', () => {
    expect(computeNextHydroTestDue('2026-01-01')).toBe('2030-12-31');
  });
});

describe('buildScbaMetadataItem (AC1)', () => {
  it('computes and stores nextFlowTestDue/nextHydroTestDue and writes the GSI2 due-soon shape', () => {
    const item = buildScbaMetadataItem(DEPT_ID, 'APP-ENGINE-2', {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    });

    expect(item.pk).toBe('DEPT#dept-001#SCBA#SCBA-001');
    expect(item.sk).toBe('METADATA');
    expect(item.entityType).toBe('SCBA_RECORD');
    expect(item.apparatusId).toBe('APP-ENGINE-2');
    expect(item.cylinderId).toBe('CYL-0891');
    expect(item.nextFlowTestDue).toBe('2027-01-01');
    expect(item.nextHydroTestDue).toBe('2031-05-31');
    expect(item.gsi2pk).toBe('DEPT#dept-001#DUE#SCBA_TEST#2027-01');
    expect(item.gsi2sk).toBe('2027-01-01#SCBA-001');
  });

  it('scopes different departments to different pk/gsi2pk for the same scbaUnitId (core-harm)', () => {
    const deptA = toVerifiedDeptId({ deptId: 'dept-a' });
    const deptB = toVerifiedDeptId({ deptId: 'dept-b' });
    const input = {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    };

    const itemA = buildScbaMetadataItem(deptA, 'ENGINE-2', input);
    const itemB = buildScbaMetadataItem(deptB, 'ENGINE-2', input);

    expect(itemA.pk).not.toBe(itemB.pk);
    expect(itemA.gsi2pk).not.toBe(itemB.gsi2pk);
  });
});

describe('buildScbaTestItem', () => {
  it('writes an append-only TEST# audit row carrying both submitted dates', () => {
    const item = buildScbaTestItem(DEPT_ID, 'APP-ENGINE-2', {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    });

    expect(item.pk).toBe('DEPT#dept-001#SCBA#SCBA-001');
    expect(item.sk).toBe('TEST#2026-01-01');
    expect(item.entityType).toBe('SCBA_TEST');
    expect(item.flowTestDate).toBe('2026-01-01');
    expect(item.hydroTestDate).toBe('2026-06-01');
  });
});

describe('parseScbaMetadataItem', () => {
  it('round-trips a stored METADATA item back into an ScbaRecord', () => {
    const item = buildScbaMetadataItem(DEPT_ID, 'APP-ENGINE-2', {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    });

    expect(parseScbaMetadataItem(item, 'dept-001')).toEqual({
      deptId: 'dept-001',
      apparatusId: 'APP-ENGINE-2',
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
      nextFlowTestDue: '2027-01-01',
      nextHydroTestDue: '2031-05-31',
    });
  });
});
