import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildScbaDueItems,
  buildScbaMetadataItem,
  buildScbaTestItem,
  computeNextFlowTestDue,
  computeNextHydroTestDue,
  parseScbaDueItem,
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
  it('computes and stores nextFlowTestDue/nextHydroTestDue', () => {
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
  });

  it('scopes different departments to different pk for the same scbaUnitId (core-harm)', () => {
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
  });
});

describe('buildScbaDueItems (AC1/AC2 — independent per-test-type GSI2 index)', () => {
  it('writes two independently-bucketed DUE items, one per test type, since the flow interval is always shorter than the hydro interval', () => {
    const [flowDue, hydroDue] = buildScbaDueItems(DEPT_ID, 'APP-ENGINE-2', {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-01-01',
    });

    expect(flowDue.sk).toBe('DUE#SCBA_FLOW');
    expect(flowDue.testType).toBe('SCBA_FLOW');
    expect(flowDue.dueDate).toBe('2027-01-01');
    expect(flowDue.gsi2pk).toBe('DEPT#dept-001#DUE#SCBA_TEST#2027-01');
    expect(flowDue.gsi2sk).toBe('2027-01-01#SCBA-001#SCBA_FLOW');

    expect(hydroDue.sk).toBe('DUE#SCBA_HYDRO');
    expect(hydroDue.testType).toBe('SCBA_HYDRO');
    expect(hydroDue.dueDate).toBe('2030-12-31');
    expect(hydroDue.gsi2pk).toBe('DEPT#dept-001#DUE#SCBA_TEST#2030-12');
    expect(hydroDue.gsi2sk).toBe('2030-12-31#SCBA-001#SCBA_HYDRO');

    // The regression this test guards: a single shared gsi2 index bucketed on
    // min(nextFlowTestDue, nextHydroTestDue) would permanently hide the hydro due date here,
    // since flow (1 year) is always sooner than hydro (5 years) when submitted together.
    expect(flowDue.gsi2pk).not.toBe(hydroDue.gsi2pk);
  });

  it('scopes different departments to different gsi2pk for the same scbaUnitId (core-harm)', () => {
    const deptA = toVerifiedDeptId({ deptId: 'dept-a' });
    const deptB = toVerifiedDeptId({ deptId: 'dept-b' });
    const input = {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    };

    const [flowDueA] = buildScbaDueItems(deptA, 'ENGINE-2', input);
    const [flowDueB] = buildScbaDueItems(deptB, 'ENGINE-2', input);

    expect(flowDueA.pk).not.toBe(flowDueB.pk);
    expect(flowDueA.gsi2pk).not.toBe(flowDueB.gsi2pk);
  });
});

describe('parseScbaDueItem', () => {
  it('round-trips a stored DUE item back into a ScbaDueEntry', () => {
    const [flowDue] = buildScbaDueItems(DEPT_ID, 'APP-ENGINE-2', {
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      flowTestDate: '2026-01-01',
      hydroTestDate: '2026-06-01',
    });

    expect(parseScbaDueItem(flowDue)).toEqual({
      apparatusId: 'APP-ENGINE-2',
      scbaUnitId: 'SCBA-001',
      cylinderId: 'CYL-0891',
      testType: 'SCBA_FLOW',
      dueDate: '2027-01-01',
    });
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
