import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;

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
  }
  return db;
}
