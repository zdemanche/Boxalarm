/**
 * Calendar-date display. API dates arrive as "YYYY-MM-DD" (certification expiries) or epoch
 * values; a volunteer should read "Oct 31, 2026 · in 21 days", not "2026-10-31".
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "YYYY-MM-DD" as local midnight. `new Date('2026-10-31')` is UTC midnight, which renders as
 * Oct 30 anywhere west of Greenwich. A full ISO timestamp (some services stamp a conducted date
 * with `toISOString()`) is the local calendar day that instant falls on.
 */
export function parseCalendarDate(isoDate: string): Date {
  if (isoDate.includes('T')) {
    const instant = new Date(isoDate);
    return new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
  }
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

/** Epoch ms as the local "YYYY-MM-DD" it falls on - the shape the helpers above take. */
export function toCalendarDate(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * "Oct 10, 2026, 7:00 PM" in the viewer's locale - to the minute. A bare `toLocaleString()` adds
 * seconds, which are noise in a list a volunteer scans. An unreadable value renders as a dash.
 */
export function formatDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
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

/**
 * The word for a due date `days` from today (see daysUntil): "Overdue · 35 days", "Due today",
 * "Due tomorrow", "Due in 5 days". Callers pick the chip colour; overdue is always the alarm.
 */
export function dueLabel(days: number): string {
  if (days < 0) return `Overdue · ${-days} ${days === -1 ? 'day' : 'days'}`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

/**
 * A span measured in hours or days - "2 d 0 h", "5 h", "1 h 5 min", "45 min". Response times
 * read as a stopwatch (1:35); an apparatus out of service for two days must not read "48:00:00".
 */
export function formatElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}
