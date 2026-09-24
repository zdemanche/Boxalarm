import type { SyncItem, SyncRepository } from './types';

let ITEMS: SyncItem[] = [
  {
    id: 'SYNC-1',
    kind: 'CHECKLIST_RUN',
    label: 'Truck check — ENGINE-2',
    status: 'QUEUED',
    queuedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    lastError: null,
  },
  {
    id: 'SYNC-2',
    kind: 'DEFECT',
    label: 'Defect report — ENGINE-2',
    status: 'FAILED',
    queuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    lastError: 'Network unreachable',
  },
];

let lastSyncAt: string | null = new Date(Date.now() - 5 * 60_000).toISOString();

// No backend/real @boxalarm/core access yet - stands in for the outbox's drain-on-reconnect
// behavior (architecture.md's sync engine section). retry() always succeeds here since this
// mock has no real network to fail against; the point is proving the UI never silently drops
// a failed item, not modeling retry failure modes.
export const mockSyncRepository: SyncRepository = {
  async getStatus() {
    return { items: ITEMS, lastSyncAt };
  },

  async retry(itemId) {
    ITEMS = ITEMS.filter((item) => item.id !== itemId);
    lastSyncAt = new Date().toISOString();
    return 'SYNCED';
  },

  async enqueue(kind, label, idempotencyKey) {
    const existing = ITEMS.find((item) => item.id === idempotencyKey);
    if (existing) return existing;
    const item = {
      id: idempotencyKey,
      kind,
      label,
      status: 'QUEUED' as const,
      queuedAt: new Date().toISOString(),
      lastError: null,
    };
    ITEMS = [...ITEMS, item];
    return item;
  },
};
