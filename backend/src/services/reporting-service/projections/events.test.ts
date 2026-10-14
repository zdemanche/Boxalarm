import { describe, expect, it } from 'vitest';
import {
  isProjectionEvent,
  MalformedEventError,
  parseDomainEvent,
  projectionWrites,
} from './events.js';

const now = 1_700_000_000_000;

describe('projection event parsing', () => {
  it('reads an EventBridge envelope and the nested payload', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        'detail-type': 'personnel.attendance.recorded',
        detail: {
          eventId: 'evt-1',
          eventType: 'personnel.attendance.recorded',
          payload: { deptId: 'NICHOLS', memberId: 'm-1', activityId: 'drill-1', losapPoints: 2 },
        },
      }),
    );
    expect(parsed.deptId).toBe('NICHOLS');
    expect(projectionWrites(parsed, now)).toEqual([]);
  });

  it('still rejects an attendance event that is missing its activityId', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        eventId: 'evt-1',
        eventType: 'personnel.attendance.recorded',
        payload: { deptId: 'NICHOLS', memberId: 'm-1' },
      }),
    );
    expect(() => projectionWrites(parsed, now)).toThrow(MalformedEventError);
  });

  it('carries the envelope eventTime as epoch milliseconds', () => {
    const iso = '2026-03-01T12:00:00.000Z';
    const parsed = parseDomainEvent(
      JSON.stringify({
        detail: {
          eventId: 'evt-1',
          eventType: 'personnel.availability.changed',
          eventTime: iso,
          payload: { deptId: 'NICHOLS', memberId: 'm-1' },
        },
      }),
    );
    expect(parsed.eventTimeMs).toBe(Date.parse(iso));
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseDomainEvent('not-json')).toThrow(MalformedEventError);
  });

  it('records a failed NERIS submission that will not retry as FAILED', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-2',
        eventType: 'neris.submission.failed',
        deptId: 'NICHOLS',
        payload: {
          incidentId: 'inc-1',
          willRetry: false,
          failureReason: 'schema',
          httpStatus: 400,
        },
      },
      now,
    );
    expect(writes[0]).toMatchObject({
      sk: 'NERIS#inc-1',
      values: { status: 'FAILED', failureReason: 'schema', httpStatus: 400 },
    });
  });

  it('keeps a retryable NERIS failure pending', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-3',
        eventType: 'neris.submission.failed',
        deptId: 'NICHOLS',
        payload: { departmentId: 'NICHOLS', incidentId: 'inc-1', willRetry: true },
      },
      now,
    );
    expect(writes[0]).toMatchObject({ values: { status: 'PENDING' } });
  });

  it('removes an apparatus rollup when the unit returns to service', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-4',
        eventType: 'apparatus.serviceStatus.changed',
        deptId: 'NICHOLS',
        payload: { unitId: 'E1', status: 'IN_SERVICE' },
      },
      now,
    );
    expect(writes).toEqual([{ kind: 'delete', sk: 'OOS#E1' }]);
  });

  it('leaves the OOS rollup to serviceStatus.changed, not the defect report', () => {
    expect(isProjectionEvent('apparatus.defect.reported')).toBe(false);
  });

  it('collapses a defect flip and its origin DEFECT status event onto one OOS row', () => {
    const fromStatus = projectionWrites(
      {
        eventId: 'evt-s',
        eventType: 'apparatus.serviceStatus.changed',
        deptId: 'NICHOLS',
        payload: { unitId: 'E1', status: 'OUT_OF_SERVICE', origin: 'DEFECT' },
      },
      now,
    );
    expect(fromStatus).toHaveLength(1);
    expect(fromStatus[0]).toMatchObject({ sk: 'OOS#E1' });
  });

  it('clears a NERIS row on approval and marks it FAILED on rejection', () => {
    const base = { deptId: 'NICHOLS', payload: { incidentId: 'inc-1', nerisStatus: 'REJECTED' } };
    expect(
      projectionWrites({ ...base, eventId: 'e1', eventType: 'neris.incident.approved' }, now),
    ).toEqual([{ kind: 'delete', sk: 'NERIS#inc-1' }]);
    expect(
      projectionWrites({ ...base, eventId: 'e2', eventType: 'neris.incident.rejected' }, now)[0],
    ).toMatchObject({ sk: 'NERIS#inc-1', values: { status: 'FAILED', failureReason: 'REJECTED' } });
    expect(
      projectionWrites({ ...base, eventId: 'e3', eventType: 'neris.incident.failed' }, now)[0],
    ).toMatchObject({ values: { status: 'FAILED' } });
  });

  it('keeps deleted and missing NERIS records on the failed tile', () => {
    const base = { deptId: 'NICHOLS', payload: { incidentId: 'inc-1' } };
    for (const [eventType, failureReason] of [
      ['neris.incident.deleted', 'DELETED'],
      ['neris.incident.missing', 'MISSING'],
    ] as const) {
      expect(projectionWrites({ ...base, eventId: 'e', eventType }, now)[0]).toMatchObject({
        sk: 'NERIS#inc-1',
        values: { status: 'FAILED', failureReason },
      });
    }
  });

  it('settles a NERIS row from the status returned at transmit time', () => {
    const at = (nerisStatus: string) =>
      projectionWrites(
        {
          eventId: 'e',
          eventType: 'neris.incident.transmitted',
          deptId: 'NICHOLS',
          payload: { incidentId: 'inc-1', nerisStatus },
        },
        now,
      );
    expect(at('APPROVED')).toEqual([{ kind: 'delete', sk: 'NERIS#inc-1' }]);
    expect(at('REJECTED')[0]).toMatchObject({
      values: { status: 'FAILED', failureReason: 'REJECTED' },
    });
    expect(at('PENDING_APPROVAL')).toEqual([]);
  });

  it('deletes the coverage row when the gap is resolved', () => {
    const event = {
      eventId: 'evt-7',
      eventType: 'scheduling.coverage_gap.resolved',
      deptId: 'NICHOLS',
      payload: { shiftId: 'shift-1' },
    };
    expect(isProjectionEvent(event.eventType)).toBe(true);
    expect(projectionWrites(event, now)).toEqual([{ kind: 'delete', sk: 'COVERAGE#shift-1' }]);
  });

  it('expires the coverage row a day after the shift ends and does not project member.created', () => {
    const write = projectionWrites(
      {
        eventId: 'evt-8',
        eventType: 'scheduling.coverage_gap.detected',
        deptId: 'NICHOLS',
        payload: { shiftId: 'shift-1', endAt: 1_800_000_000_000 },
      },
      now,
    )[0];
    expect(write).toMatchObject({
      values: { endAt: 1_800_000_000_000, ttl: 1_800_000_000 + 86_400 },
    });
    expect(isProjectionEvent('personnel.member.created')).toBe(false);
  });

  it('stores a coverage gap and an expiring certification', () => {
    expect(
      projectionWrites(
        {
          eventId: 'evt-5',
          eventType: 'scheduling.coverage_gap.detected',
          deptId: 'NICHOLS',
          payload: { shiftId: 'shift-1', gapReason: 'no officer', requiredQuals: ['OFFICER'] },
        },
        now,
      )[0],
    ).toMatchObject({ sk: 'COVERAGE#shift-1' });
    expect(
      projectionWrites(
        {
          eventId: 'evt-6',
          eventType: 'cert.expiry.due',
          deptId: 'NICHOLS',
          payload: { memberId: 'm-1', certId: 'c-1', expiryDate: '2026-10-01', leadDays: 30 },
        },
        now,
      )[0],
    ).toMatchObject({
      sk: 'CERT#c-1',
      values: {
        expiryDate: '2026-10-01',
        leadDays: 30,
        ttl: Date.parse('2026-10-02T00:00:00.000Z') / 1000,
      },
    });
  });

  it('marks a member unavailable from a mark-off event', () => {
    const writes = projectionWrites(
      {
        eventId: 'evt-7',
        eventType: 'personnel.availability.changed',
        deptId: 'NICHOLS',
        payload: { memberId: 'm-1', availabilityState: 'MARKED_OFF' },
      },
      now,
    );
    expect(writes[0]).toMatchObject({ sk: 'MEMBER#m-1', values: { available: false } });
  });

  it('writes nothing for a member.updated that carries no status (e.g. a role change)', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        detail: {
          eventId: 'evt-9',
          eventType: 'personnel.member.updated',
          payload: { deptId: 'NICHOLS', memberId: 'm-1', roles: ['MEMBER', 'OFFICER'] },
        },
      }),
    );
    expect(projectionWrites(parsed, now)).toEqual([]);
  });

  it('rejects a member.updated with neither memberId nor status instead of skipping it', () => {
    const parsed = parseDomainEvent(
      JSON.stringify({
        detail: {
          eventId: 'evt-10',
          eventType: 'personnel.member.updated',
          payload: { deptId: 'NICHOLS' },
        },
      }),
    );
    expect(() => projectionWrites(parsed, now)).toThrow();
  });
});
