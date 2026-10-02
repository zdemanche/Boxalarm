import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;
let ownerColumns = true;

// answeredAsHint (R4-M1): the signed-in member when an ownerless answer was queued.
const OWNER_COLUMNS = ['ownerMemberId', 'ownerDeptId', 'answeredAsHint'] as const;

/**
 * Adds the owner columns (R2-M3) to an outbox created before they existed. Checks
 * PRAGMA table_info rather than catching every error: if an ALTER genuinely fails (locked or
 * read-only file, full disk) it logs and returns false instead of every insert throwing - an
 * alert answer must always be saveable. In that mode rows are stored without owners and the
 * outbox runs unscoped, as before R2-M3: listDrainable and getStatus (outbox.ts) treat every row
 * as the signed-in member's, so checks, defects, attendance and mark-offs keep sending. What is
 * lost is only the protection against sending one member's rows under another's session.
 */
export function migrateOutboxOwnerColumns(
  database: Pick<DB, 'executeSync'>,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): boolean {
  try {
    const info = database.executeSync('PRAGMA table_info(outbox)');
    const existing = new Set((info.rows ?? []).map((row) => String(row.name)));
    for (const column of OWNER_COLUMNS) {
      if (!existing.has(column))
        database.executeSync(`ALTER TABLE outbox ADD COLUMN ${column} TEXT`);
    }
    return true;
  } catch (error) {
    log('[outbox] adding owner columns failed; queued work is not owner-scoped', error);
    return false;
  }
}

/** False when the owner columns couldn't be added: rows are stored and read without owners. */
export function outboxHasOwnerColumns(): boolean {
  getDb();
  return ownerColumns;
}

/**
 * Opens and initialises the database once per process. The handle is cached only after both
 * tables exist and the migration has run (m7): a failure part-way - a transient I/O error in a
 * headless page task - throws to this caller and the next call starts again, instead of caching
 * a handle with no outbox table that fails every later insert (alert answers included) for the
 * life of the process.
 */
export function getDb(): DB {
  if (db) return db;
  const opened = open({ name: 'boxalarm-outbox.db' });
  try {
    opened.executeSync(
      `CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        stage TEXT NOT NULL,
        photoLocalUri TEXT,
        photoS3Key TEXT,
        photoUploadUrl TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lastError TEXT,
        queuedAt TEXT NOT NULL,
        nextAttemptAt INTEGER NOT NULL,
        syncedAt TEXT
      )`,
    );
    const hasOwnerColumns = migrateOutboxOwnerColumns(opened);
    // Small device-local cache (kvStore.ts): the alert payload a page arrived with, the last
    // good dispatch detail and active-call list, and this device's latest answer per call - so
    // the alert path renders from the phone, never from a spinner.
    opened.executeSync(
      `CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
    );
    ownerColumns = hasOwnerColumns;
    db = opened;
    return db;
  } catch (error) {
    try {
      opened.close();
    } catch {
      // Already unusable; the next call opens a fresh handle.
    }
    throw error;
  }
}
