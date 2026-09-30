/** "Wed, Oct 1, 18:00 – 06:00": the window a volunteer plans around, without seconds. */
export function formatShiftWindow(startAt: number, endAt: number): string {
  const start = new Date(startAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const end = new Date(endAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${start} – ${end}`;
}
