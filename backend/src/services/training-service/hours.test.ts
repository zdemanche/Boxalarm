import { describe, expect, it } from 'vitest';
import { aggregateMemberHoursByCategory, aggregateRosterHoursByCategory } from './hours.js';
import type { AttendanceHoursRecord, TrainingEvent } from './repository.js';

describe('aggregateMemberHoursByCategory', () => {
  it('sums hours per category across fixture attendance records, including a zero-hours category (ticket Test notes, AC1)', () => {
    const records: readonly AttendanceHoursRecord[] = [
      { memberId: 'member-1', category: 'fireground', hours: 2 },
      { memberId: 'member-1', category: 'fireground', hours: 1.5 },
      { memberId: 'member-1', category: 'ems', hours: 0 },
    ];

    const result = aggregateMemberHoursByCategory(records);

    expect(result).toEqual(
      expect.arrayContaining([
        { category: 'fireground', hours: 3.5 },
        { category: 'ems', hours: 0 },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  it('returns an empty array when the member has no attendance records in range', () => {
    expect(aggregateMemberHoursByCategory([])).toEqual([]);
  });
});

describe('aggregateRosterHoursByCategory', () => {
  const events: readonly TrainingEvent[] = [
    { eventId: 'e1', title: 'Drill 1', category: 'fireground', startAt: 100, endAt: 200 },
    { eventId: 'e2', title: 'Drill 2', category: 'ems', startAt: 300, endAt: 400 },
  ];

  it('aggregates per-member category totals across multiple events without a per-member caller loop (AC2)', () => {
    const attendeesByEvent = new Map<string, readonly AttendanceHoursRecord[]>([
      [
        'e1',
        [
          { memberId: 'member-1', category: 'fireground', hours: 2 },
          { memberId: 'member-2', category: 'fireground', hours: 0 },
        ],
      ],
      ['e2', [{ memberId: 'member-1', category: 'ems', hours: 1 }]],
    ]);

    const result = aggregateRosterHoursByCategory(events, attendeesByEvent);
    const byMember = new Map(result.map((entry) => [entry.memberId, entry.categories]));

    expect(byMember.get('member-1')).toEqual(
      expect.arrayContaining([
        { category: 'fireground', hours: 2 },
        { category: 'ems', hours: 1 },
      ]),
    );
    expect(byMember.get('member-2')).toEqual([{ category: 'fireground', hours: 0 }]);
  });

  it('produces no members when no matched event has attendees', () => {
    expect(aggregateRosterHoursByCategory(events, new Map())).toEqual([]);
  });
});
