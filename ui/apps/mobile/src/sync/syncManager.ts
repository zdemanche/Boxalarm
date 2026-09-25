import NetInfo from '@react-native-community/netinfo';
import { apiRequest, type AuthTokenSource } from '../lib/apiClient';
import type { SyncQueueStatus } from '../features/sync/types';
import * as outbox from './outbox';
import type { OutboxKind, OutboxRow } from './outbox';

type Listener = (status: SyncQueueStatus) => void;

let tokens: AuthTokenSource | null = null;
let apiBaseUrl: string | null = null;
let draining = false;
// Set once the startup reconciliation of stranded SYNCING rows has run for this process.
let recoveredOrphans = false;
let lastSyncAt: string | null = null;
const listeners = new Set<Listener>();

export function configure(nextTokens: AuthTokenSource | null, nextApiBaseUrl: string | null): void {
  tokens = nextTokens;
  apiBaseUrl = nextApiBaseUrl;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  void notify();
  return () => {
    listeners.delete(listener);
  };
}

async function notify(): Promise<void> {
  const status = await outbox.getStatus(lastSyncAt);
  listeners.forEach((listener) => listener(status));
}

function unitPath(unitId: string, suffix: string): string {
  return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;
}

async function enqueueAndDrain(
  kind: OutboxKind,
  id: string,
  label: string,
  path: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await outbox.enqueue({ id, kind, label, path, body, photoLocalUri });
  await notify();
  void drain();
}

export async function enqueueChecklistRun(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  await enqueueAndDrain(
    'CHECKLIST_RUN',
    idempotencyKey,
    `Truck check — ${unitId}`,
    unitPath(unitId, 'checks'),
    body,
  );
}

export async function enqueueDefect(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'DEFECT',
    idempotencyKey,
    `Defect report — ${unitId}`,
    unitPath(unitId, 'defects'),
    body,
    photoLocalUri,
  );
}

export async function retry(id: string): Promise<void> {
  await outbox.retry(id);
  await notify();
  void drain();
}

function guessPhotoContentType(uri: string): string {
  const extension = uri.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

async function uploadPhoto(row: OutboxRow): Promise<void> {
  if (!row.photoLocalUri || !row.photoUploadUrl) return;
  const fileResponse = await fetch(row.photoLocalUri);
  const blob = await fileResponse.blob();
  const uploadResponse = await fetch(row.photoUploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': guessPhotoContentType(row.photoLocalUri) },
  });
  if (!uploadResponse.ok) {
    throw new Error(`Photo upload failed with status ${uploadResponse.status}`);
  }
}

async function processEntry(id: string): Promise<void> {
  if (!tokens || !apiBaseUrl) throw new Error('Sync is not configured yet');
  let row = await outbox.find(id);
  if (!row) return;

  if (row.stage === 'CREATE') {
    const response = await apiRequest(row.path, tokens, {
      apiBaseUrl,
      method: row.method,
      headers: { 'Content-Type': 'application/json' },
      body: row.body,
    });
    const parsed = (await response.json().catch(() => ({}))) as {
      uploadUrl?: string;
      photoS3Key?: string;
    };
    const nextStage = parsed.uploadUrl && row.photoLocalUri ? 'UPLOAD_PHOTO' : 'DONE';
    await outbox.advanceStage(row.id, {
      stage: nextStage,
      photoUploadUrl: parsed.uploadUrl ?? null,
      photoS3Key: parsed.photoS3Key ?? null,
    });
    row = await outbox.find(row.id);
    if (!row) return;
  }

  if (row.stage === 'UPLOAD_PHOTO') {
    await uploadPhoto(row);
    await outbox.advanceStage(row.id, { stage: 'DONE' });
  }
}

export async function drain(): Promise<void> {
  if (draining || !tokens || !apiBaseUrl) return;
  draining = true;
  try {
    // Runs inside the draining lock so no row of this process can be genuinely mid-sync.
    if (!recoveredOrphans) {
      await outbox.recoverOrphanedSyncing();
      recoveredOrphans = true;
    }
    const netState = await NetInfo.fetch();
    if (netState.isConnected !== true) return;

    const pending = await outbox.listDrainable(Date.now());
    for (const row of pending) {
      await outbox.markSyncing(row.id);
      await notify();
      try {
        await processEntry(row.id);
        await outbox.markSynced(row.id);
        lastSyncAt = new Date().toISOString();
      } catch (error) {
        await outbox.markFailed(row.id, error instanceof Error ? error.message : String(error));
      }
      await notify();
    }
  } finally {
    draining = false;
  }
}

NetInfo.addEventListener((state) => {
  if (state.isConnected === true) void drain();
});
