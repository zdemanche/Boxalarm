/** "just now", "3 min ago", "1 h 12 min ago" - elapsed time since a dispatch, for a glance. */
export function formatElapsed(sinceMs: number, nowMs: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
}

/** 24-hour clock time, the way a fire service reads it: "02:14". */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
