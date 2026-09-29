/**
 * Calendar months in the department's own time zone (a call at 20:00 on the last evening
 * of the month belongs to that month, not the next — review minor 6). No date library:
 * the offset for an instant comes from Intl, re-checked once for DST transitions.
 */

export const DEFAULT_TIME_ZONE = 'America/New_York';

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at `epochMs` (negative west of Greenwich). */
function offsetMinutes(epochMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/** Epoch ms of local midnight on `year-month-01` in `timeZone`. */
export function zonedMonthStart(year: number, month: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, 1);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  return guess - offsetMinutes(first, timeZone) * 60_000;
}

/** `YYYY-MM` -> [start, end] epoch seconds, inclusive, in `timeZone`. */
export function zonedMonthBounds(month: string, timeZone: string): { from: number; to: number } {
  const [year, mm] = month.split('-').map(Number) as [number, number];
  return {
    from: zonedMonthStart(year, mm, timeZone) / 1000,
    to: zonedMonthStart(mm === 12 ? year + 1 : year, mm === 12 ? 1 : mm + 1, timeZone) / 1000 - 1,
  };
}

/** The `YYYY-MM` that `epochMs` falls in, in `timeZone`. */
export function zonedMonth(epochMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

/** The month before `month` (`YYYY-MM`). */
export function previousMonthOf(month: string): string {
  const [year, mm] = month.split('-').map(Number) as [number, number];
  return mm === 1 ? `${year - 1}-12` : `${year}-${String(mm - 1).padStart(2, '0')}`;
}
