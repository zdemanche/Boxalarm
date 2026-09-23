import { describe, expect, it } from 'vitest';
import { computeMembershipTrend } from './membershipTrend.js';
import type { AttendanceRecord, MemberTimeline } from './memberTimeline.js';

const JAN_1 = Date.UTC(2026, 0, 1);
const FEB_15 = Date.UTC(2026, 1, 15);
const MAR_1 = Date.UTC(2026, 2, 1);

describe('computeMembershipTrend', () => {
  it('returns zero counts and empty buckets for an empty roster', () => {
    const result = computeMembershipTrend([], [], JAN_1, MAR_1);

    expect(result.startCount).toBe(0);
    expect(result.endCount).toBe(0);
    expect(result.netChange).toBe(0);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets.every((bucket) => bucket.activeMemberCount === 0)).toBe(true);
  });

  it('echoes the resolved period in the response (AC visibility)', () => {
    const result = computeMembershipTrend([], [], JAN_1, MAR_1);
    expect(result.periodStart).toBe(new Date(JAN_1).toISOString());
    expect(result.periodEnd).toBe(new Date(MAR_1).toISOString());
  });

  it('reflects a member active->retired mid-period only from its effectiveFrom onward, never retroactively (AC3, core-harm)', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-1',
        joinedAt: JAN_1 - 1,
        intervals: [
          { status: 'ACTIVE', effectiveFrom: JAN_1 },
          { status: 'RETIRED', effectiveFrom: FEB_15 },
        ],
      },
    ];

    const result = computeMembershipTrend(timelines, [], JAN_1, MAR_1);

    expect(result.startCount).toBe(1);
    expect(result.endCount).toBe(0);
    expect(result.departures).toBe(1);
    expect(result.netChange).toBe(-1);

    const januaryBucket = result.buckets.find((b) => b.bucket === '2026-01');
    const februaryBucket = result.buckets.find((b) => b.bucket === '2026-02');
    expect(januaryBucket?.activeMemberCount).toBe(1);
    expect(februaryBucket?.activeMemberCount).toBe(1);
  });

  it('counts a member whose joinedAt falls inside the period as a join, even if their first retained interval is later (AC1)', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-2',
        joinedAt: FEB_15,
        intervals: [{ status: 'PROBATIONARY', effectiveFrom: FEB_15 }],
      },
    ];

    const result = computeMembershipTrend(timelines, [], JAN_1, MAR_1);

    expect(result.joins).toBe(1);
    expect(result.startCount).toBe(0);
  });

  it('does not count a member as a join when their joinedAt precedes the window even if a retained interval starts inside it (archived-audit, core-harm)', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-3',
        joinedAt: JAN_1 - 1,
        intervals: [{ status: 'ACTIVE', effectiveFrom: FEB_15 }],
      },
    ];

    const result = computeMembershipTrend(timelines, [], JAN_1, MAR_1);

    expect(result.joins).toBe(0);
  });

  it('uses the same inclusive boundary for joins and departures so netChange agrees with endCount - startCount at a boundary instant', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-join',
        joinedAt: JAN_1,
        intervals: [{ status: 'ACTIVE', effectiveFrom: JAN_1 }],
      },
      {
        memberId: 'mbr-leave',
        joinedAt: JAN_1 - 10,
        intervals: [
          { status: 'ACTIVE', effectiveFrom: JAN_1 - 10 },
          { status: 'RETIRED', effectiveFrom: JAN_1 },
        ],
      },
    ];

    const result = computeMembershipTrend(timelines, [], JAN_1, MAR_1);

    expect(result.joins).toBe(1);
    expect(result.departures).toBe(1);
    expect(result.netChange).toBe(0);
  });

  it('counts a member retired, reinstated, and retired again in-window as one departure, not two', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-4',
        joinedAt: JAN_1 - 100,
        intervals: [
          { status: 'ACTIVE', effectiveFrom: JAN_1 - 100 },
          { status: 'RETIRED', effectiveFrom: JAN_1 + 1000 },
          { status: 'ACTIVE', effectiveFrom: JAN_1 + 2000 },
          { status: 'RETIRED', effectiveFrom: JAN_1 + 3000 },
        ],
      },
    ];

    const result = computeMembershipTrend(timelines, [], JAN_1, MAR_1);

    expect(result.departures).toBe(1);
  });

  it('computes attendance rate by activity type per monthly bucket as attending/active members (AC2)', () => {
    const timelines: readonly MemberTimeline[] = [
      {
        memberId: 'mbr-1',
        joinedAt: JAN_1,
        intervals: [{ status: 'ACTIVE', effectiveFrom: JAN_1 }],
      },
      {
        memberId: 'mbr-2',
        joinedAt: JAN_1,
        intervals: [{ status: 'ACTIVE', effectiveFrom: JAN_1 }],
      },
    ];
    const attendance: readonly AttendanceRecord[] = [
      { memberId: 'mbr-1', activityType: 'DRILL', occurredAt: JAN_1 + 1000 },
    ];

    const result = computeMembershipTrend(timelines, attendance, JAN_1, MAR_1);

    const januaryBucket = result.buckets.find((b) => b.bucket === '2026-01');
    expect(januaryBucket?.attendanceRateByActivityType.DRILL).toBe(0.5);
    expect(januaryBucket?.attendanceRateByActivityType.CALL).toBe(0);
  });

  it('does not divide by zero when a bucket has no active members', () => {
    const result = computeMembershipTrend([], [], JAN_1, JAN_1);

    expect(result.buckets[0]?.attendanceRateByActivityType.CALL).toBe(0);
  });
});
