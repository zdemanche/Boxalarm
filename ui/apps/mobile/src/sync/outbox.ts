import * as store from './outboxStore';
import type { OutboxKind, OutboxRow } from './outboxStore';
import type { SyncItem, SyncQueueStatus } from '../features/sync/types';

export type { OutboxRow, OutboxKind } from './outboxStore';

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface EnqueueInput {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly label: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly photoLocalUri?: string;
  /** The member (and department) whose work this is; null only when no session could say. */
  readonly ownerMemberId: string | null;
  readonly ownerDeptId: string | null;
  /** Set only when ownerMemberId is null: see OutboxRow.answeredAsHint. */
  readonly answeredAsHint?: string | null;
}

// Create-only by design: the id is the client idempotency key, so re-enqueueing an id already in
// the outbox is a no-op that keeps the ORIGINAL payload (any changed fields are dropped). There is
// no edit/merge or cross-device conflict handling - if an update (PUT/PATCH) path is ever queued
// here, it needs update-in-place and a conflict strategy rather than this dedup.
export async function enqueue(input: EnqueueInput): Promise<OutboxRow> {
  const existing = await store.find(input.id);
  if (existing) return existing;
  const row: OutboxRow = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    method: 'POST',
    path: input.path,
    body: JSON.stringify(input.body),
    stage: 'CREATE',
    photoLocalUri: input.photoLocalUri ?? null,
    photoS3Key: null,
    photoUploadUrl: null,
    status: 'QUEUED',
    attempts: 0,
    lastError: null,
    queuedAt: new Date().toISOString(),
    nextAttemptAt: Date.now(),
    syncedAt: null,
    ownerMemberId: input.ownerMemberId,
    ownerDeptId: input.ownerDeptId,
    answeredAsHint: input.ownerMemberId === null ? (input.answeredAsHint ?? null) : null,
  };
  await store.insert(row);
  return row;
}

/**
 * Rows of `kind` for the same `path` queued before `row` - an older answer to the same call.
 * Answers are append-only on the server and the latest write wins there, so an older answer
 * that is still retrying must never be delivered after a newer one.
 */
export async function olderSiblings(row: OutboxRow): Promise<OutboxRow[]> {
  const rows = await store.all();
  return rows.filter(
    (candidate) =>
      candidate.id !== row.id &&
      candidate.kind === row.kind &&
      candidate.path === row.path &&
      candidate.ownerMemberId === row.ownerMemberId &&
      candidate.queuedAt <= row.queuedAt,
  );
}

/** True when a newer row of the same kind and path exists (see olderSiblings). */
export async function isSuperseded(row: OutboxRow): Promise<boolean> {
  const rows = await store.all();
  return rows.some(
    (candidate) =>
      candidate.id !== row.id &&
      candidate.kind === row.kind &&
      candidate.path === row.path &&
      candidate.ownerMemberId === row.ownerMemberId &&
      candidate.queuedAt > row.queuedAt,
  );
}

/** Replaces a queued row's body (the RESPONSE missing-ETA fallback, syncManager.post). */
export async function replaceBody(id: string, body: string): Promise<void> {
  await store.update(id, { body });
}

export async function find(id: string): Promise<OutboxRow | undefined> {
  return store.find(id);
}

/**
 * An alert answer never stranded by a missing owner (R3-C1), and never sent as someone else
 * (R4-M1): an ownerless RESPONSE auto-sends only if it was queued within the answer window AND
 * the phone's session at the time (answeredAsHint, cleared on every sign-out) is the member now
 * signed in. Anything else waits for an explicit Send or Discard.
 */
export const OWNERLESS_RESPONSE_WINDOW_MS = 2 * 60 * 60 * 1000;

export function isRecentOwnerlessResponse(
  row: OutboxRow,
  now: number,
  signedInMemberId: string | null,
): boolean {
  return (
    row.ownerMemberId === null &&
    row.kind === 'RESPONSE' &&
    signedInMemberId !== null &&
    row.answeredAsHint === signedInMemberId &&
    now - Date.parse(row.queuedAt) < OWNERLESS_RESPONSE_WINDOW_MS
  );
}

/** Rows the signed-in member may send now: their own (R2-M3) and recent ownerless answers
 * (R3-C1). Another member's rows, and other ownerless rows, are held. */
export async function listDrainable(
  now: number,
  ownerMemberId: string | null,
): Promise<OutboxRow[]> {
  const rows = await store.all();
  return rows.filter(
    (row) =>
      ((ownerMemberId !== null && row.ownerMemberId === ownerMemberId) ||
        isRecentOwnerlessResponse(row, now, ownerMemberId)) &&
      row.status !== 'SYNCING' &&
      row.status !== 'REJECTED' &&
      row.nextAttemptAt <= now,
  );
}

/** Rows the member queued and hasn't sent yet - what signing out would leave behind. */
export async function countUnsentFor(ownerMemberId: string): Promise<number> {
  const rows = await store.all();
  return rows.filter((row) => row.ownerMemberId === ownerMemberId).length;
}

export async function discardAllFor(ownerMemberId: string): Promise<void> {
  const rows = await store.all();
  await Promise.all(
    rows.filter((row) => row.ownerMemberId === ownerMemberId).map((row) => store.remove(row.id)),
  );
}

/** A row with no recorded owner, which the signed-in member explicitly chose to send as theirs. */
export async function adopt(id: string, ownerMemberId: string, ownerDeptId: string | null) {
  const row = await store.find(id);
  if (!row || row.ownerMemberId !== null) return;
  await store.update(id, {
    ownerMemberId,
    ownerDeptId,
    status: 'QUEUED',
    nextAttemptAt: Date.now(),
  });
}

export async function markSyncing(id: string): Promise<void> {
  await store.update(id, { status: 'SYNCING' });
}

/** markSyncing that loses to a concurrent removeIfUnattempted instead of racing it. */
export async function claimForSync(id: string): Promise<boolean> {
  return store.claimForSync(id);
}

/** Drops a row only if nothing has ever been sent for it: its POST cannot have landed. */
export async function discardIfUnattempted(id: string): Promise<boolean> {
  return store.removeIfUnattempted(id);
}

// A row is only SYNCING while this process's drain() is working on it, so any SYNCING row found
// before the first drain of a process was stranded by a kill/crash mid-sync. Without this reset
// listDrainable would exclude it forever. Safe to re-POST: the row id is the idempotency key.
export async function recoverOrphanedSyncing(): Promise<void> {
  const rows = await store.all();
  const orphaned = rows.filter((row) => row.status === 'SYNCING');
  await Promise.all(
    orphaned.map((row) => store.update(row.id, { status: 'QUEUED', nextAttemptAt: Date.now() })),
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  const row = await store.find(id);
  const attempts = (row?.attempts ?? 0) + 1;
  const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  await store.update(id, {
    status: 'FAILED',
    attempts,
    lastError: error,
    nextAttemptAt: Date.now() + backoffMs,
  });
}

export async function markRejected(id: string, error: string): Promise<void> {
  const row = await store.find(id);
  await store.update(id, {
    status: 'REJECTED',
    attempts: (row?.attempts ?? 0) + 1,
    lastError: error,
  });
}

export async function markSynced(id: string): Promise<void> {
  await store.remove(id);
}

export async function retry(id: string): Promise<void> {
  await store.update(id, { status: 'QUEUED', nextAttemptAt: Date.now() });
}

export async function discard(id: string): Promise<void> {
  await store.remove(id);
}

export async function advanceStage(
  id: string,
  patch: {
    readonly stage: 'CREATE' | 'UPLOAD_PHOTO' | 'DONE';
    readonly photoUploadUrl?: string | null;
    readonly photoS3Key?: string | null;
  },
): Promise<void> {
  await store.update(id, patch);
}

/** The signed-in member's view of the queue: their own rows, rows with no recorded owner
 * (flagged for an explicit send-or-discard), and only a count of other members' rows. */
export async function getStatus(
  lastSyncAt: string | null,
  ownerMemberId: string | null,
  now: number = Date.now(),
): Promise<SyncQueueStatus> {
  const rows = await store.all();
  const visible = rows.filter(
    (row) =>
      row.ownerMemberId === null || (ownerMemberId !== null && row.ownerMemberId === ownerMemberId),
  );
  const items: SyncItem[] = visible.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    queuedAt: row.queuedAt,
    lastError: row.lastError,
    ...(row.ownerMemberId === null && !isRecentOwnerlessResponse(row, now, ownerMemberId)
      ? { needsOwner: true }
      : {}),
  }));
  return {
    items,
    lastSyncAt,
    heldForOtherMembers: rows.length - visible.length,
  };
}
