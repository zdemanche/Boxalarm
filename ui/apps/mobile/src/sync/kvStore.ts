import { getDb } from './db';

export interface KvEntry<T> {
  readonly value: T;
  /** Epoch ms of the write, so a reader can say "as of {time}" about cached data. */
  readonly updatedAt: number;
}

/**
 * Device-local JSON cache on the same SQLite file as the outbox. Reads never throw: a cache that
 * cannot be read is treated as empty, because every caller has a live source to fall back on and
 * the alert path must not fail on a cache error.
 */
export async function kvGet<T>(key: string): Promise<KvEntry<T> | null> {
  try {
    const result = await getDb().execute('SELECT key, value, updatedAt FROM kv WHERE key = ?', [
      key,
    ]);
    const record = result.rows[0];
    if (!record) return null;
    return { value: JSON.parse(String(record.value)) as T, updatedAt: Number(record.updatedAt) };
  } catch (error) {
    console.warn(`[cache] reading ${key} failed`, error);
    return null;
  }
}

export async function kvSet<T>(key: string, value: T, now: number = Date.now()): Promise<void> {
  try {
    await getDb().execute('INSERT OR REPLACE INTO kv (key, value, updatedAt) VALUES (?, ?, ?)', [
      key,
      JSON.stringify(value),
      now,
    ]);
  } catch (error) {
    console.warn(`[cache] writing ${key} failed`, error);
  }
}

/** Deletes every key starting with `prefix` (a key range, so no LIKE-escaping of ids). */
export async function kvDeletePrefix(prefix: string): Promise<void> {
  if (!prefix) return;
  try {
    await getDb().execute('DELETE FROM kv WHERE key >= ? AND key < ?', [prefix, `${prefix}\uffff`]);
  } catch (error) {
    console.warn(`[cache] clearing ${prefix}* failed`, error);
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    await getDb().execute('DELETE FROM kv WHERE key = ?', [key]);
  } catch (error) {
    console.warn(`[cache] deleting ${key} failed`, error);
  }
}
