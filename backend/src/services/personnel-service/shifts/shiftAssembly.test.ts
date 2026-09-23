import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ValidationError,
  buildShiftTransactItems,
  parseCreateShiftRequest,
  parseShiftListItems,
} from './shiftAssembly.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: 1_000,
    endAt: 2_000,
    stationId: 'station-1',
    positions: [{ positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' }],
    ...overrides,
  };
}

describe('parseCreateShiftRequest', () => {
  it('rejects an absent body', () => {
    expect(() => parseCreateShiftRequest(undefined)).toThrow(ValidationError);
  });

  it('rejects a null body', () => {
    expect(() => parseCreateShiftRequest(null)).toThrow(ValidationError);
  });

  it('rejects an empty positions array', () => {
    expect(() => parseCreateShiftRequest(validBody({ positions: [] }))).toThrow(
      'at least one position is required',
    );
  });

  it('rejects positions that is not an array', () => {
    expect(() =>
      parseCreateShiftRequest(validBody({ positions: { positionCode: 'DRIVER' } })),
    ).toThrow('positions must be an array');
  });

  it('rejects a non-numeric startAt', () => {
    expect(() => parseCreateShiftRequest(validBody({ startAt: 'not-a-number' }))).toThrow(
      'startAt must be a finite epoch number',
    );
  });

  it('rejects a non-numeric endAt', () => {
    expect(() => parseCreateShiftRequest(validBody({ endAt: 'not-a-number' }))).toThrow(
      'endAt must be a finite epoch number',
    );
  });

  it('rejects endAt not after startAt', () => {
    expect(() => parseCreateShiftRequest(validBody({ startAt: 2_000, endAt: 1_000 }))).toThrow(
      'endAt must be after startAt',
    );
  });

  it('rejects a missing stationId', () => {
    expect(() => parseCreateShiftRequest(validBody({ stationId: '' }))).toThrow(
      'stationId is required and must be a non-empty string',
    );
  });

  it('rejects a position without positionCode', () => {
    expect(() =>
      parseCreateShiftRequest(validBody({ positions: [{ requiredQual: 'X' }] })),
    ).toThrow('positions[0].positionCode is required and must be a non-empty string');
  });

  it('accepts a position with no requiredQual (AC1 optional)', () => {
    const parsed = parseCreateShiftRequest(validBody({ positions: [{ positionCode: 'DRIVER' }] }));
    const [position] = parsed.positions;
    expect(position).toEqual({ positionCode: 'DRIVER' });
    expect(position && 'requiredQual' in position).toBe(false);
  });

  it('rejects duplicate positionCodes', () => {
    expect(() =>
      parseCreateShiftRequest(
        validBody({
          positions: [{ positionCode: 'DRIVER' }, { positionCode: 'DRIVER' }],
        }),
      ),
    ).toThrow('positions[1].positionCode is duplicated');
  });

  it('rejects more than 99 positions', () => {
    const positions = Array.from({ length: 100 }, (_, index) => ({
      positionCode: `POS-${index}`,
    }));
    expect(() => parseCreateShiftRequest(validBody({ positions }))).toThrow(
      'positions cannot exceed 99 entries',
    );
  });
});

describe('buildShiftTransactItems', () => {
  it('builds one DUTY_SHIFT Put and one SHIFT_POSITION Put per position, dept-scoped via buildDeptScopedPk', () => {
    const input = parseCreateShiftRequest(
      validBody({
        positions: [
          { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' },
          { positionCode: 'OFFICER' },
        ],
      }),
    );
    const items = buildShiftTransactItems(DEPT_ID, 'shift-123', 'platform-service', input);

    expect(items).toHaveLength(3);
    const shiftItem = items[0]?.Put;
    expect(shiftItem?.TableName).toBe('platform-service');
    expect(shiftItem?.Item).toMatchObject({
      pk: 'DEPT#dept-001#SHIFT#shift-123',
      sk: 'METADATA',
      entityType: 'DUTY_SHIFT',
      status: 'OPEN',
      gsi3pk: 'DEPT#dept-001#DUTY_SHIFT',
      gsi3sk: '1000',
    });

    const driverPosition = items[1]?.Put;
    expect(driverPosition?.Item).toMatchObject({
      pk: 'DEPT#dept-001#SHIFT#shift-123',
      sk: 'POSITION#DRIVER',
      entityType: 'SHIFT_POSITION',
      positionCode: 'DRIVER',
      requiredQual: 'DRIVER_OPERATOR',
    });
    expect(driverPosition?.Item?.claimedByMemberId).toBeUndefined();

    const officerPosition = items[2]?.Put;
    expect(officerPosition?.Item).toMatchObject({
      sk: 'POSITION#OFFICER',
      positionCode: 'OFFICER',
    });
    expect(officerPosition?.Item && 'requiredQual' in officerPosition.Item).toBe(false);
  });
});

describe('parseShiftListItems', () => {
  it('maps raw query items to the shift list shape', () => {
    const parsed = parseShiftListItems([
      {
        pk: 'DEPT#dept-001#SHIFT#shift-123',
        sk: 'METADATA',
        shiftId: 'shift-123',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        status: 'OPEN',
      },
    ]);
    expect(parsed).toEqual([
      {
        shiftId: 'shift-123',
        startAt: 1_000,
        endAt: 2_000,
        stationId: 'station-1',
        status: 'OPEN',
      },
    ]);
  });

  it('maps an empty item list to an empty list', () => {
    expect(parseShiftListItems([])).toEqual([]);
  });
});
