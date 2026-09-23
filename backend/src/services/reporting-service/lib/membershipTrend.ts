import {
  statusAt,
  ACTIVITY_TYPES,
  type MemberTimeline,
  type ActivityType,
  type AttendanceRecord,
} from './memberTimeline.js';

export interface MembershipTrendBucket {
  readonly bucket: string;
  readonly activeMemberCount: number;
  readonly attendanceRateByActivityType: Readonly<Record<ActivityType, number>>;
}

export interface MembershipTrendResult {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly startCount: number;
  readonly endCount: number;
  readonly joins: number;
  readonly departures: number;
  readonly netChange: number;
  readonly buckets: readonly MembershipTrendBucket[];
}

function monthBucketKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStartMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonthStartMs(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function generateBucketStarts(startMs: number, endMs: number): readonly number[] {
  const starts: number[] = [];
  let cursor = monthStartMs(startMs);
  while (cursor <= endMs) {
    starts.push(cursor);
    cursor = nextMonthStartMs(cursor);
  }
  return starts;
}

function indexAttendanceByBucket(
  attendance: readonly AttendanceRecord[],
  bucketStarts: readonly number[],
): ReadonlyMap<number, readonly AttendanceRecord[]> {
  const byBucket = new Map<number, AttendanceRecord[]>();
  for (const bucketStart of bucketStarts) {
    byBucket.set(bucketStart, []);
  }
  for (const record of attendance) {
    const bucketStart = monthStartMs(record.occurredAt);
    byBucket.get(bucketStart)?.push(record);
  }
  return byBucket;
}

export function computeMembershipTrend(
  timelines: readonly MemberTimeline[],
  attendance: readonly AttendanceRecord[],
  startMs: number,
  endMs: number,
): MembershipTrendResult {
  const startCount = timelines.filter((t) => statusAt(t, startMs) === 'ACTIVE').length;
  const endCount = timelines.filter((t) => statusAt(t, endMs) === 'ACTIVE').length;

  let joins = 0;
  const departedMemberIds = new Set<string>();
  for (const timeline of timelines) {
    if (timeline.joinedAt >= startMs && timeline.joinedAt <= endMs) {
      joins += 1;
    }
    for (const interval of timeline.intervals) {
      if (
        interval.status === 'RETIRED' &&
        interval.effectiveFrom >= startMs &&
        interval.effectiveFrom <= endMs
      ) {
        departedMemberIds.add(timeline.memberId);
        break;
      }
    }
  }
  const departures = departedMemberIds.size;

  const bucketStarts = generateBucketStarts(startMs, endMs);
  const attendanceByBucket = indexAttendanceByBucket(attendance, bucketStarts);

  const buckets = bucketStarts.map((bucketStart) => {
    const activeMemberIds = new Set(
      timelines.filter((t) => statusAt(t, bucketStart) === 'ACTIVE').map((t) => t.memberId),
    );
    const attendanceInBucket = attendanceByBucket.get(bucketStart) ?? [];

    const attendanceRateByActivityType = Object.fromEntries(
      ACTIVITY_TYPES.map((activityType) => {
        const attendingMemberIds = new Set(
          attendanceInBucket
            .filter(
              (record) =>
                record.activityType === activityType && activeMemberIds.has(record.memberId),
            )
            .map((record) => record.memberId),
        );
        const rate =
          activeMemberIds.size === 0 ? 0 : attendingMemberIds.size / activeMemberIds.size;
        return [activityType, rate];
      }),
    ) as Record<ActivityType, number>;

    return {
      bucket: monthBucketKey(bucketStart),
      activeMemberCount: activeMemberIds.size,
      attendanceRateByActivityType,
    };
  });

  return {
    periodStart: new Date(startMs).toISOString(),
    periodEnd: new Date(endMs).toISOString(),
    startCount,
    endCount,
    joins,
    departures,
    netChange: joins - departures,
    buckets,
  };
}
