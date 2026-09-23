import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ValidationError,
  buildDueGsi2Keys,
  buildDueGsi2Pk,
  buildInspectionKeys,
  hasInspectionId,
  parseConductPayload,
  parseSchedulePayload,
  resolveDueWindow,
  toApiInspection,
  validateViolation,
  type InspectionItem,
} from './inspectionRecord.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

describe('buildInspectionKeys (AC1)', () => {
  it('builds a dept-scoped pk under the occupancy partition and an INSPECTION# sk', () => {
    expect(buildInspectionKeys(DEPT_ID, 'OCC-1', 'INS-1')).toEqual({
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-1',
    });
  });
});

describe('buildDueGsi2Keys / buildDueGsi2Pk (AC1, AC4)', () => {
  it('builds the DUE#INSPECTION_RECORD month bucket and a date-sortable sk', () => {
    expect(buildDueGsi2Keys(DEPT_ID, '2026-10-05', 'INS-1')).toEqual({
      gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
      gsi2sk: '2026-10-05#INS-1',
    });
    expect(buildDueGsi2Pk(DEPT_ID, '2026-10')).toBe('DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10');
  });
});

describe('parseSchedulePayload (AC1)', () => {
  it('accepts a well-formed schedule body', () => {
    expect(parseSchedulePayload({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' })).toEqual({
      occupancyId: 'OCC-1',
      scheduledDate: '2026-10-05',
    });
  });

  it.each([
    [{}, 'occupancy'],
    [{ occupancyId: '' }, 'occupancy'],
    [{ occupancyId: 42 }, 'occupancy'],
    [{ occupancyId: 'OCC-1' }, 'scheduledDate'],
    [{ occupancyId: 'OCC-1', scheduledDate: 'not-a-date' }, 'scheduledDate'],
    [{ occupancyId: 'OCC#1', scheduledDate: '2026-10-05' }, 'occupancy'],
    [null, 'object'],
    ['string-body', 'object'],
  ])('rejects %j with a detail mentioning %s', (body, needle) => {
    expect(() => parseSchedulePayload(body)).toThrow(ValidationError);
    try {
      parseSchedulePayload(body);
    } catch (error) {
      expect((error as ValidationError).detail.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
});

describe('validateViolation / parseConductPayload (AC2, AC3)', () => {
  it('accepts open and resolved statuses', () => {
    expect(validateViolation({ code: 'V1', description: 'bad', status: 'open' }, 0)).toEqual({
      code: 'V1',
      description: 'bad',
      status: 'open',
    });
    expect(validateViolation({ code: 'V2', description: 'fixed', status: 'resolved' }, 0)).toEqual({
      code: 'V2',
      description: 'fixed',
      status: 'resolved',
    });
  });

  it('rejects a wrong-enum status such as "closed"', () => {
    expect(() => validateViolation({ code: 'V1', description: 'x', status: 'closed' }, 0)).toThrow(
      ValidationError,
    );
  });

  it('rejects a violation missing code/description', () => {
    expect(() => validateViolation({ description: 'x', status: 'open' }, 2)).toThrow(
      /violations\[2\]/,
    );
  });

  it('parses a well-formed conduct body with multiple violations', () => {
    expect(
      parseConductPayload({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        violations: [
          { code: 'V1', description: 'bad wiring', status: 'open' },
          { code: 'V2', description: 'fixed exit sign', status: 'resolved' },
        ],
      }),
    ).toEqual({
      occupancyId: 'OCC-1',
      inspectionId: 'INS-1',
      violations: [
        { code: 'V1', description: 'bad wiring', status: 'open' },
        { code: 'V2', description: 'fixed exit sign', status: 'resolved' },
      ],
    });
  });

  it('rejects violations that is an object instead of an array', () => {
    expect(() =>
      parseConductPayload({ occupancyId: 'OCC-1', inspectionId: 'INS-1', violations: {} }),
    ).toThrow(ValidationError);
  });

  it("rejects an occupancyId or inspectionId containing '#' with a ValidationError instead of reaching the key builder", () => {
    expect(() =>
      parseConductPayload({ occupancyId: 'OCC#1', inspectionId: 'INS-1', violations: [] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseConductPayload({ occupancyId: 'OCC-1', inspectionId: 'INS#1', violations: [] }),
    ).toThrow(ValidationError);
  });
});

describe('hasInspectionId', () => {
  it('distinguishes a schedule body from a conduct body', () => {
    expect(hasInspectionId({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' })).toBe(false);
    expect(hasInspectionId({ inspectionId: 'INS-1', violations: [] })).toBe(true);
    expect(hasInspectionId(undefined)).toBe(false);
  });
});

describe('resolveDueWindow (AC4)', () => {
  it('defaults leadDays to 30 and derives the window from the current UTC month when month is absent', () => {
    const window = resolveDueWindow(undefined, new Date('2026-09-14T00:00:00.000Z'));
    expect(window.months).toEqual(['2026-09', '2026-10']);
    expect(window.startBound).toBe('2026-09-14');
    expect(window.endBound).toBe('2026-10-14#￿');
  });

  it('anchors the window on the provided month, staying within one month when leadDays is small', () => {
    const window = resolveDueWindow(
      { month: '2026-11', leadDays: '5' },
      new Date('2026-09-14T00:00:00.000Z'),
    );
    expect(window.months).toEqual(['2026-11']);
    expect(window.startBound).toBe('2026-11-01');
  });

  it('rejects a NaN-producing leadDays', () => {
    expect(() => resolveDueWindow({ leadDays: 'abc' }, new Date())).toThrow(ValidationError);
  });

  it('rejects a negative leadDays', () => {
    expect(() => resolveDueWindow({ leadDays: '-1' }, new Date())).toThrow(ValidationError);
  });

  it('rejects a malformed month', () => {
    expect(() => resolveDueWindow({ month: '2026-9' }, new Date())).toThrow(ValidationError);
  });

  it('enumerates every intermediate month for a window spanning 3+ calendar months, not just the endpoints', () => {
    const window = resolveDueWindow(
      { month: '2026-01', leadDays: '65' },
      new Date('2026-09-14T00:00:00.000Z'),
    );
    expect(window.months).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('toApiInspection (AC3)', () => {
  it('extracts occupancyId/inspectionId from the keys and surfaces violation status', () => {
    const item: InspectionItem = {
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-1',
      entityType: 'INSPECTION_RECORD',
      scheduledDate: '2026-10-05',
      conductedDate: '2026-10-06T12:00:00.000Z',
      conductedBy: 'member-1',
      violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
      nextDueDate: '2026-10-05',
      gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
      gsi2sk: '2026-10-05#INS-1',
    };
    expect(toApiInspection(item)).toEqual({
      occupancyId: 'OCC-1',
      inspectionId: 'INS-1',
      scheduledDate: '2026-10-05',
      conductedDate: '2026-10-06T12:00:00.000Z',
      conductedBy: 'member-1',
      violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
      nextDueDate: '2026-10-05',
    });
  });

  it('passes photoS3Keys through when present (E5-S7 field capture)', () => {
    const item: InspectionItem = {
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-3',
      entityType: 'INSPECTION_RECORD',
      scheduledDate: '2026-10-05',
      violations: [],
      photoS3Keys: ['dept-001/INSPECTION_RECORD/INS-3/photo.jpg'],
      nextDueDate: '2026-10-05',
      gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
      gsi2sk: '2026-10-05#INS-3',
    };
    expect(toApiInspection(item).photoS3Keys).toEqual([
      'dept-001/INSPECTION_RECORD/INS-3/photo.jpg',
    ]);
  });

  it('omits photoS3Keys when absent', () => {
    const item: InspectionItem = {
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-4',
      entityType: 'INSPECTION_RECORD',
      scheduledDate: '2026-10-05',
      violations: [],
      nextDueDate: '2026-10-05',
      gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
      gsi2sk: '2026-10-05#INS-4',
    };
    expect(toApiInspection(item)).not.toHaveProperty('photoS3Keys');
  });

  it('omits conductedDate/conductedBy for a scheduled-but-not-yet-conducted item', () => {
    const item: InspectionItem = {
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-2',
      entityType: 'INSPECTION_RECORD',
      scheduledDate: '2026-10-05',
      violations: [],
      nextDueDate: '2026-10-05',
      gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
      gsi2sk: '2026-10-05#INS-2',
    };
    const api = toApiInspection(item);
    expect(api).not.toHaveProperty('conductedDate');
    expect(api).not.toHaveProperty('conductedBy');
  });
});
