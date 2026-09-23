// UI-side shape of @boxalarm/core's outbox contract (architecture.md's sync engine section) -
// the real sync engine (SQLite-backed outbox, NetInfo-driven drain) is that package's scope, not
// this repo's; this models just enough of its contract for the sync-status banner and per-screen
// offline states to be built now and activate without a UI rewrite once @boxalarm/core ships.

export type SyncItemStatus = 'QUEUED' | 'SYNCING' | 'FAILED';

// kind mirrors the outbox entry's underlying entity type (CHECKLIST_RUN, DEFECT, AVAILABILITY,
// SHIFT_CLAIM, ...) so a failed-item row can show what actually failed, not just "an item."
export interface SyncItem {
  id: string;
  kind: string;
  label: string;
  status: SyncItemStatus;
  queuedAt: string; // ISO
  lastError: string | null;
}

export interface SyncQueueStatus {
  items: SyncItem[];
  lastSyncAt: string | null; // ISO, null if nothing has ever synced this session
}

export interface SyncRepository {
  getStatus(): Promise<SyncQueueStatus>;
  // F7.7's "never silently dropped" applies here too: a failed item stays queued until retried,
  // never dropped automatically.
  retry(itemId: string): Promise<'SYNCED' | 'FAILED'>;
}
