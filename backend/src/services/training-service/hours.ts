import type { AttendanceHoursRecord, TrainingEvent } from './repository.js';

export interface CategoryHours {
  readonly category: string;
  readonly hours: number;
}

export interface MemberCategoryHours {
  readonly memberId: string;
  readonly categories: readonly CategoryHours[];
}

export function aggregateMemberHoursByCategory(
  records: readonly AttendanceHoursRecord[],
): readonly CategoryHours[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    totals.set(record.category, (totals.get(record.category) ?? 0) + record.hours);
  }
  return [...totals.entries()].map(([category, hours]) => ({ category, hours }));
}

export function aggregateRosterHoursByCategory(
  events: readonly TrainingEvent[],
  attendeesByEvent: ReadonlyMap<string, readonly AttendanceHoursRecord[]>,
): readonly MemberCategoryHours[] {
  const byMember = new Map<string, Map<string, number>>();
  for (const event of events) {
    for (const record of attendeesByEvent.get(event.eventId) ?? []) {
      const categoryTotals = byMember.get(record.memberId) ?? new Map<string, number>();
      categoryTotals.set(
        record.category,
        (categoryTotals.get(record.category) ?? 0) + record.hours,
      );
      byMember.set(record.memberId, categoryTotals);
    }
  }
  return [...byMember.entries()].map(([memberId, categoryTotals]) => ({
    memberId,
    categories: [...categoryTotals.entries()].map(([category, hours]) => ({ category, hours })),
  }));
}
