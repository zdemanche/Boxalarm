export const REPORT_TIME_ZONE = 'America/New_York';

function localIsoDate(epochMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIME_ZONE }).format(new Date(epochMs));
}

/** YYYY-MM-DD for today in the department time zone, the value shape a native date input takes. */
export function todayIsoDate(): string {
  return localIsoDate(Date.now());
}

export function isoDateDaysAgo(days: number): string {
  return localIsoDate(Date.now() - days * 86_400_000);
}

/** Midnight UTC of the given calendar date, in epoch seconds - for date arithmetic only. */
export function isoDateToEpochSeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

function zoneOffsetSeconds(epochSeconds: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: REPORT_TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(epochSeconds * 1000))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const wallAsUtc =
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour, parts.minute, parts.second) /
    1000;
  return wallAsUtc - epochSeconds;
}

function localMidnightEpochSeconds(wallAsUtc: number): number {
  if (!Number.isFinite(wallAsUtc)) return NaN;
  const firstGuess = wallAsUtc - zoneOffsetSeconds(wallAsUtc);
  return wallAsUtc - zoneOffsetSeconds(firstGuess);
}

/** First and last second of the given calendar date in the department time zone. */
export function dayBounds(isoDate: string): { from: number; to: number } {
  const wallAsUtc = isoDateToEpochSeconds(isoDate);
  return {
    from: localMidnightEpochSeconds(wallAsUtc),
    to: localMidnightEpochSeconds(wallAsUtc + 86_400) - 1,
  };
}

/** m:ss (or h:mm:ss) for a duration in seconds; an em dash when it could not be measured. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A 0..1 fraction as a whole-number percentage. */
export function formatPercent(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** An ISO string or epoch-ms number as a local date + time. */
export function formatDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
