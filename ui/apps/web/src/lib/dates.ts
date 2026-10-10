/**
 * Calendar-date display. API dates arrive as "YYYY-MM-DD" (certification expiries) or epoch
 * values; a volunteer should read "Oct 31, 2026 · in 21 days", not "2026-10-31".
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "YYYY-MM-DD" as local midnight. `new Date('2026-10-31')` is UTC midnight, which renders as
 * Oct 30 anywhere west of Greenwich.
 */
export function parseCalendarDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

/** "Oct 31, 2026" in the viewer's locale. */
export function formatCalendarDate(isoDate: string): string {
  return parseCalendarDate(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Whole calendar days from today to `isoDate`; negative once it has passed. */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseCalendarDate(isoDate).getTime() - today.getTime()) / MS_PER_DAY);
}

/** "today", "tomorrow", "in 21 days", "yesterday", "3 days ago". */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
