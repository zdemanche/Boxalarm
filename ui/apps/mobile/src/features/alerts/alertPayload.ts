import { kvGet, kvSet } from '../../sync/kvStore';
import type { DispatchAlert } from './types';

/**
 * What a page carries on its own, before any network call (design.md §4.3: F-01 renders from the
 * push payload alone). Plain strings and numbers only - it travels as navigation params and in
 * the notification's data map.
 */
export interface AlertPayload {
  dispatchId: string;
  incidentType: string;
  address: string;
  crossStreets?: string;
  toneSequence?: number;
  /** Epoch ms the server dispatched the call, when the page carries it (review MJ-2). */
  dispatchedAt?: number;
  /** Epoch ms this phone received the page (iOS: the notification's delivery date). Shown as
   * "received", never as the dispatch time. */
  receivedAt: number;
}

type PushData = Record<string, unknown> | undefined;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads the page out of a push/notification data map. The alerting service sends `title` =
 * incident type and `body` = "{incident type} — {address}" (deliverChannelMessage.ts), so until it
 * sends `incidentType`/`address` as their own keys the address is the body minus its title prefix.
 * Explicit keys win when present. Returns null without a dispatchId - there is nothing to open.
 */
export function alertPayloadFromPushData(data: PushData, receivedAt: number): AlertPayload | null {
  const dispatchId = str(data?.dispatchId);
  if (!dispatchId) return null;
  const title = str(data?.title);
  const body = str(data?.body);
  const incidentType = str(data?.incidentType) ?? title ?? 'Dispatch';
  let address = str(data?.address);
  if (!address && body) {
    const prefix = title ? `${title} — ` : null;
    address = prefix && body.startsWith(prefix) ? body.slice(prefix.length).trim() : body;
  }
  const tone = Number(data?.toneSequence);
  const dispatchedAt = Number(data?.dispatchedAt);
  const crossStreets = str(data?.crossStreets);
  return {
    dispatchId,
    incidentType,
    address: address ?? '',
    ...(crossStreets ? { crossStreets } : {}),
    ...(Number.isInteger(tone) && tone > 0 ? { toneSequence: tone } : {}),
    // dispatchedAt, when the server adds it, is epoch seconds like every other alerting time.
    ...(Number.isFinite(dispatchedAt) && dispatchedAt > 0
      ? { dispatchedAt: dispatchedAt * 1000 }
      : {}),
    receivedAt,
  };
}

/** The notification data map a payload round-trips through (Android notifee data: strings only). */
export function alertPayloadToNotificationData(payload: AlertPayload): Record<string, string> {
  return {
    dispatchId: payload.dispatchId,
    incidentType: payload.incidentType,
    address: payload.address,
    ...(payload.crossStreets ? { crossStreets: payload.crossStreets } : {}),
    ...(payload.toneSequence ? { toneSequence: String(payload.toneSequence) } : {}),
    ...(payload.dispatchedAt
      ? { dispatchedAt: String(Math.floor(payload.dispatchedAt / 1000)) }
      : {}),
    receivedAt: String(payload.receivedAt),
  };
}

/** Inverse of alertPayloadToNotificationData (explicit keys, so no body parsing needed). */
export function alertPayloadFromNotificationData(data: PushData): AlertPayload | null {
  const receivedAt = Number(data?.receivedAt);
  return alertPayloadFromPushData(data, Number.isFinite(receivedAt) ? receivedAt : Date.now());
}

const payloadKey = (dispatchId: string) => `alert-payload:${dispatchId}`;
const detailKey = (dispatchId: string) => `alert-detail:${dispatchId}`;

/** The self-test page (alerting selfTest/dispatchAdapter.ts incidentType SELF_TEST). */
export function isSelfTestPayload(payload: Pick<AlertPayload, 'incidentType'>): boolean {
  const type = payload.incidentType
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return type === 'SELF_TEST';
}

/** Keeps the first receipt time: tone 2 of the same call must not reset "3 min ago". */
export async function rememberAlertPayload(payload: AlertPayload): Promise<void> {
  const existing = await kvGet<AlertPayload>(payloadKey(payload.dispatchId));
  const merged = mergePayload(existing?.value ?? null, payload);
  await kvSet(payloadKey(payload.dispatchId), merged);
  // A test page is not a call: it must never show in the offline Alerts list (review m13).
  if (isSelfTestPayload(payload)) return;
  const recent = (await kvGet<AlertPayload[]>(RECENT_PAGES_KEY))?.value ?? [];
  // The same merge as the per-call record (review m5): a later tone with an empty address or no
  // cross streets must not blank what the offline list already knows.
  const previous = recent.find((p) => p.dispatchId === payload.dispatchId) ?? null;
  const listed = mergePayload(previous ?? existing?.value ?? null, payload);
  await kvSet(
    RECENT_PAGES_KEY,
    [listed, ...recent.filter((p) => p.dispatchId !== payload.dispatchId)].slice(
      0,
      RECENT_PAGES_LIMIT,
    ),
  );
}

/** Newer fields win, but never with an empty value, and the first receipt time is kept. */
function mergePayload(existing: AlertPayload | null, next: AlertPayload): AlertPayload {
  if (!existing) return next;
  return {
    ...existing,
    ...next,
    receivedAt: Math.min(existing.receivedAt, next.receivedAt),
    address: next.address || existing.address,
    incidentType: next.incidentType || existing.incidentType,
    ...(next.crossStreets || existing.crossStreets
      ? { crossStreets: next.crossStreets || existing.crossStreets }
      : {}),
    ...(next.dispatchedAt || existing.dispatchedAt
      ? { dispatchedAt: next.dispatchedAt ?? existing.dispatchedAt }
      : {}),
  };
}

const RECENT_PAGES_KEY = 'recent-pages';
const RECENT_PAGES_LIMIT = 10;

/** Pages this phone received, newest first - the Alerts list's fallback when the server list
 * cannot be read, so a swiped-away notification never takes the call with it. */
export async function recentPages(): Promise<AlertPayload[]> {
  return (await kvGet<AlertPayload[]>(RECENT_PAGES_KEY))?.value ?? [];
}

export async function cachedAlertPayload(dispatchId: string): Promise<AlertPayload | null> {
  return (await kvGet<AlertPayload>(payloadKey(dispatchId)))?.value ?? null;
}

export async function rememberDispatchDetail(detail: DispatchAlert): Promise<void> {
  await kvSet(detailKey(detail.dispatchId), detail);
}

export async function cachedDispatchDetail(
  dispatchId: string,
): Promise<{ detail: DispatchAlert; updatedAt: number } | null> {
  const entry = await kvGet<DispatchAlert>(detailKey(dispatchId));
  return entry ? { detail: entry.value, updatedAt: entry.updatedAt } : null;
}
