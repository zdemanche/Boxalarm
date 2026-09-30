import { ApiError } from '../lib/apiClient';
import { kvGet, kvSet } from './kvStore';

/**
 * The phone has never loaded this data, and cannot reach the server now. Screens show an honest
 * offline state ("This phone hasn't loaded ... yet. Connect once to download it.") - never
 * made-up data in its place.
 */
export class NoCachedDataError extends Error {
  constructor(what: string, options?: { cause?: unknown }) {
    super(`This phone hasn't loaded ${what} yet, and there is no connection to fetch it.`);
    this.name = 'NoCachedDataError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export interface ReadThroughResult<T> {
  readonly value: T;
  /** Epoch ms the value was fetched from the server, when it came from this phone's cache
   * because the server couldn't be reached; null when it is a live response. */
  readonly cachedAt: number | null;
}

/**
 * Live read that remembers its last good answer on this phone (kvStore, the outbox's SQLite
 * file). A server refusal (ApiError: 401/403/404/5xx) is real signal and is rethrown - it is
 * never masked by cached data. Only a failure to reach the server at all (no signal, timeout)
 * falls back to the last real response, flagged with its timestamp so the screen can say "as of".
 * With nothing cached it throws NoCachedDataError.
 */
export async function readThrough<T>(
  key: string,
  what: string,
  fetchLive: () => Promise<T>,
): Promise<ReadThroughResult<T>> {
  try {
    const value = await fetchLive();
    await kvSet(key, value);
    return { value, cachedAt: null };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const cached = await kvGet<T>(key);
    if (cached) return { value: cached.value, cachedAt: cached.updatedAt };
    throw new NoCachedDataError(what, { cause: error });
  }
}

/** "as of 14:02" for today, "as of Sep 28, 14:02" otherwise - how old the cached copy is. */
export function formatAsOf(epochMs: number, now: number = Date.now()): string {
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
