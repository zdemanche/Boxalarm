export function epochToDateInput(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function dateInputToEpoch(value: string, endOfDay: boolean): number {
  const ms = Date.parse(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  return Math.floor(ms / 1000);
}

export function formatDate(epochSeconds?: number): string {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

export function formatTimestamp(epochSeconds?: number): string {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function epochToDateTimeLocal(epochSeconds?: number): string {
  if (!epochSeconds) return '';
  const date = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeLocalToEpoch(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

export function coreStrings(payload: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}
