import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;
let ownerColumns = true;

const OWNER_COLUMNS = ['ownerMemberId', 'ownerDeptId'] as const;

/**
 * Adds the owner columns (R2-M3) to an outbox created before they existed. Checks
 * PRAGMA table_info rather than catching every error: if an ALTER genuinely fails (locked or
 * read-only file, full disk) it logs and returns false, and the outbox keeps working without
 * owner scoping instead of every insert throwing - an alert answer must always be saveable.
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

export function getDb(): DB {
  if (!db) {
    db = open({ name: 'boxalarm-outbox.db' });
    db.executeSync(
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
    ownerColumns = migrateOutboxOwnerColumns(db);
    // Small device-local cache (kvStore.ts): the alert payload a page arrived with, the last
    // good dispatch detail and active-call list, and this device's latest answer per call - so
    // the alert path renders from the phone, never from a spinner.
    db.executeSync(
      `CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
    );
  }
  return db;
}
