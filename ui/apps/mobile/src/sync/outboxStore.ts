import { getDb, outboxHasOwnerColumns } from './db';

export type OutboxKind =
  | 'CHECKLIST_RUN'
  | 'CHECK_PHOTO'
  | 'DEFECT'
  | 'FIELD_CAPTURE'
  | 'ATTENDANCE'
  | 'RESPONSE'
  | 'AVAILABILITY';
export type OutboxStage = 'CREATE' | 'UPLOAD_PHOTO' | 'DONE';
// FAILED is transient (retried with backoff); REJECTED is terminal (the server refused the
// request itself, e.g. a 4xx validation error) and waits for the user to retry or discard it.
export type OutboxRowStatus = 'QUEUED' | 'SYNCING' | 'FAILED' | 'REJECTED';

export interface OutboxRow {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly label: string;
  readonly method: 'POST';
  readonly path: string;
  readonly body: string;
  readonly stage: OutboxStage;
  readonly photoLocalUri: string | null;
  readonly photoS3Key: string | null;
  readonly photoUploadUrl: string | null;
  readonly status: OutboxRowStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly queuedAt: string;
  readonly nextAttemptAt: number;
  readonly syncedAt: string | null;
  /** Member whose session queued this row; sent only under that member (R2-M3). NULL = queued
   * before owners were recorded; '' = a session with no member id (dev/test builds only). */
  readonly ownerMemberId: string | null;
  readonly ownerDeptId: string | null;
  /** Only on ownerless rows: the member the phone's last session belonged to when the row was
   * queued (R4-M1). Never an owner - it only decides whether an ownerless answer may auto-send. */
  readonly answeredAsHint?: string | null;
}

function toRow(record: Record<string, unknown>): OutboxRow {
  return {
    id: String(record.id),
    kind: record.kind as OutboxKind,
    label: String(record.label),
    method: 'POST',
    path: String(record.path),
    body: String(record.body),
    stage: record.stage as OutboxStage,
    photoLocalUri: (record.photoLocalUri as string | null) ?? null,
    photoS3Key: (record.photoS3Key as string | null) ?? null,
    photoUploadUrl: (record.photoUploadUrl as string | null) ?? null,
    status: record.status as OutboxRowStatus,
    attempts: Number(record.attempts),
    lastError: (record.lastError as string | null) ?? null,
    queuedAt: String(record.queuedAt),
    nextAttemptAt: Number(record.nextAttemptAt),
    syncedAt: (record.syncedAt as string | null) ?? null,
    // '' was stamped by one pre-release build for "no member id"; it means the same as NULL.
    ownerMemberId: (record.ownerMemberId as string | null) || null,
    ownerDeptId: (record.ownerDeptId as string | null) ?? null,
    answeredAsHint: (record.answeredAsHint as string | null) || null,
  };
}

export async function insert(row: OutboxRow): Promise<void> {
  if (!outboxHasOwnerColumns()) {
    await getDb().execute(
      `INSERT INTO outbox
        (id, kind, label, method, path, body, stage, photoLocalUri, photoS3Key, photoUploadUrl,
         status, attempts, lastError, queuedAt, nextAttemptAt, syncedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.label,
        row.method,
        row.path,
        row.body,
        row.stage,
        row.photoLocalUri,
        row.photoS3Key,
        row.photoUploadUrl,
        row.status,
        row.attempts,
        row.lastError,
        row.queuedAt,
        row.nextAttemptAt,
        row.syncedAt,
      ],
    );
    return;
  }
  await getDb().execute(
    `INSERT INTO outbox
      (id, kind, label, method, path, body, stage, photoLocalUri, photoS3Key, photoUploadUrl,
       status, attempts, lastError, queuedAt, nextAttemptAt, syncedAt, ownerMemberId, ownerDeptId,
       answeredAsHint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.kind,
      row.label,
      row.method,
      row.path,
      row.body,
      row.stage,
      row.photoLocalUri,
      row.photoS3Key,
      row.photoUploadUrl,
      row.status,
      row.attempts,
      row.lastError,
      row.queuedAt,
      row.nextAttemptAt,
      row.syncedAt,
      row.ownerMemberId,
      row.ownerDeptId,
      row.answeredAsHint ?? null,
    ],
  );
}

export async function all(): Promise<OutboxRow[]> {
  const result = await getDb().execute('SELECT * FROM outbox ORDER BY queuedAt ASC');
  return result.rows.map(toRow);
}

export async function find(id: string): Promise<OutboxRow | undefined> {
  const result = await getDb().execute('SELECT * FROM outbox WHERE id = ?', [id]);
  const record = result.rows[0];
  return record ? toRow(record) : undefined;
}

export async function update(id: string, patch: Partial<OutboxRow>): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([key]) =>
      outboxHasOwnerColumns() ||
      (key !== 'ownerMemberId' && key !== 'ownerDeptId' && key !== 'answeredAsHint'),
  );
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value ?? null);
  await getDb().execute(`UPDATE outbox SET ${assignments} WHERE id = ?`, [...values, id]);
}

/**
 * Moves a row to SYNCING unless it is already there or gone. Atomic in SQLite, so it can't
 * interleave with removeIfUnattempted: whichever runs first wins. Returns whether it claimed it.
 */
export async function claimForSync(id: string): Promise<boolean> {
  const result = await getDb().execute(
    "UPDATE outbox SET status = 'SYNCING' WHERE id = ? AND status != 'SYNCING'",
    [id],
  );
  return (result.rowsAffected ?? 0) > 0;
}

/** Deletes a row only if it has never been sent (QUEUED, zero attempts). Returns whether it did. */
export async function removeIfUnattempted(id: string): Promise<boolean> {
  const result = await getDb().execute(
    "DELETE FROM outbox WHERE id = ? AND status = 'QUEUED' AND attempts = 0",
    [id],
  );
  return (result.rowsAffected ?? 0) > 0;
}

/** Deletes a row unless a drain is sending it right now. Returns whether it did. */
export async function removeUnlessSyncing(id: string): Promise<boolean> {
  const result = await getDb().execute("DELETE FROM outbox WHERE id = ? AND status != 'SYNCING'", [
    id,
  ]);
  return (result.rowsAffected ?? 0) > 0;
}

export async function remove(id: string): Promise<void> {
  await getDb().execute('DELETE FROM outbox WHERE id = ?', [id]);
}
