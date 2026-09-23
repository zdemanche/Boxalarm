import { describe, expect, it } from 'vitest';
import { assembleShiftCoverage, classifyPosition } from './coverageAssembly.js';

describe('classifyPosition', () => {
  it('classifies a claimed position as covered regardless of requiredQual', () => {
    const status = classifyPosition(
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', claimedByMemberId: 'member-1' },
      new Set(),
    );
    expect(status).toBe('covered');
  });

  it('classifies an unclaimed position with no requiredQual as short', () => {
    const status = classifyPosition({ positionCode: 'OFFICER' }, new Set());
    expect(status).toBe('short');
  });

  it('classifies an unclaimed position as short when an eligible member holds the requiredQual', () => {
    const status = classifyPosition(
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' },
      new Set(['DRIVER_OPERATOR']),
    );
    expect(status).toBe('short');
  });

  it('classifies an unclaimed position as qual-gapped when no currently-eligible member holds the requiredQual (AC2)', () => {
    const status = classifyPosition(
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' },
      new Set(),
    );
    expect(status).toBe('qual-gapped');
  });
});

describe('assembleShiftCoverage', () => {
  it('classifies every position on a shift with mixed claim states (AC1)', () => {
    const entry = assembleShiftCoverage(
      {
        shiftId: 'shift-1',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        positions: [
          { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', claimedByMemberId: 'm-1' },
          { positionCode: 'FF1' },
          { positionCode: 'OFFICER', requiredQual: 'OFFICER_CERT' },
        ],
      },
      new Set(),
    );

    expect(entry.positions.map((position) => position.status)).toEqual([
      'covered',
      'short',
      'qual-gapped',
    ]);
  });

  it('returns an empty positions array for a shift with no positions, without throwing', () => {
    const entry = assembleShiftCoverage(
      { shiftId: 'shift-1', startAt: 1_000, endAt: 2_000, stationId: 'station-1', positions: [] },
      new Set(),
    );
    expect(entry.positions).toEqual([]);
  });

  it('rolls a shift up to covered when every position is covered', () => {
    const entry = assembleShiftCoverage(
      {
        shiftId: 'shift-1',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        positions: [{ positionCode: 'DRIVER', claimedByMemberId: 'm-1' }],
      },
      new Set(),
    );
    expect(entry.status).toBe('covered');
  });

  it('rolls a shift up to short when any position is short and none are qual-gapped', () => {
    const entry = assembleShiftCoverage(
      {
        shiftId: 'shift-1',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        positions: [{ positionCode: 'DRIVER', claimedByMemberId: 'm-1' }, { positionCode: 'FF1' }],
      },
      new Set(),
    );
    expect(entry.status).toBe('short');
  });

  it('rolls a shift up to qual-gapped when any position is qual-gapped, even if others are short (AC1)', () => {
    const entry = assembleShiftCoverage(
      {
        shiftId: 'shift-1',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        positions: [
          { positionCode: 'FF1' },
          { positionCode: 'OFFICER', requiredQual: 'OFFICER_CERT' },
        ],
      },
      new Set(),
    );
    expect(entry.status).toBe('qual-gapped');
  });
});
