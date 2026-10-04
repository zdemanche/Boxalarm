import { createHash } from 'node:crypto';

/**
 * The one shape a notification-service push can take: an ordinary, non-critical alert.
 *
 * This module is the worker's whole payload vocabulary, and it is non-critical **by
 * construction**: the interruption level, sound, priorities and routing category below are
 * literal constants, there is no `aps.category` (so no RESPONDING/NOT-RESPONDING actions), and
 * nothing here accepts a caller-supplied level or channel. A page — critical sound, DISPATCH
 * category, DND-bypassing Android channel — cannot be expressed through these builders, however
 * the worker is called. The alerting plane's dispatch shape lives with the alerting worker and
 * is not importable here (isolation sweeps).
 */

/**
 * The app-side routing key. The mobile app routes `category: 'digest'` to its non-critical
 * DEFAULT notifee channel (`notifications-default`, pushChannel.ts channelForCategory) and
 * everything else to the critical dispatch channel — so this constant is load-bearing: it is
 * what keeps a notification-service push off the dispatch channel on Android.
 */
export const NON_CRITICAL_PUSH_CATEGORY = 'digest';

/** A tap routes here: the in-app inbox, where every digest/immediate notification is written. */
export const NOTIFICATION_DEEP_LINK_PATH = '/notifications';

/** How long APNs/FCM keep trying an offline phone: a day — reminders stay useful, pages don't. */
export const NON_CRITICAL_PUSH_TTL_SECONDS = 86_400;

/**
 * APNs refuses payloads over 4096 bytes; a digest body (one line per expiring item) can be
 * long, so both texts are bounded in UTF-8 bytes. The full list is in the inbox the tap opens.
 */
export const NON_CRITICAL_TEXT_MAX_BYTES = { title: 128, body: 1024 } as const;

export interface NonCriticalPush {
  readonly title: string;
  readonly body: string;
  /** The notification-service category ('cert-expiry', 'apparatus-status', …). */
  readonly notificationCategory: string;
  /**
   * Stable per logical notification per member: a redelivered SQS record carries the same
   * apns-id and collapse id, so the device shows one notification, re-attempted.
   */
  readonly idempotencyKey: string;
}

/** Cuts `value` to at most `maxBytes` of UTF-8, never splitting a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes - 3) {
      return `${out}…`;
    }
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * apns-id must be a UUID. Name-based (RFC 9562 v8 layout over SHA-256) on the idempotency key,
 * the same derivation the alerting worker uses for its exactly-once key.
 */
export function apnsIdFor(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedTitle(push: NonCriticalPush): string {
  return truncateUtf8(push.title, NON_CRITICAL_TEXT_MAX_BYTES.title);
}

function boundedBody(push: NonCriticalPush): string {
  return truncateUtf8(push.body, NON_CRITICAL_TEXT_MAX_BYTES.body);
}

/**
 * Custom keys the app reads (pushChannel.ts categoryFromPushData, pushNotificationDisplay.ts):
 * `category` routes to the non-critical channel, `path` is the in-app destination of a tap.
 * FCM data values must be strings.
 */
export function nonCriticalDataFields(push: NonCriticalPush): Record<string, string> {
  return {
    category: NON_CRITICAL_PUSH_CATEGORY,
    notificationCategory: push.notificationCategory,
    path: NOTIFICATION_DEEP_LINK_PATH,
    title: boundedTitle(push),
    body: boundedBody(push),
  };
}

/**
 * Ordinary alert presentation: default sound, `active` interruption level (never breaks
 * through Do Not Disturb or Focus), no action category, no critical-sound dictionary, no
 * mutable-content. Everything presentation-shaped is a literal.
 */
export function buildNonCriticalApnsPayload(push: NonCriticalPush): Record<string, unknown> {
  return {
    aps: {
      alert: { title: boundedTitle(push), body: boundedBody(push) },
      sound: 'default',
      'interruption-level': 'active',
    },
    ...nonCriticalDataFields(push),
  };
}

/** Absolute APNs expiry (epoch seconds) for a push sent at `nowMs`. */
function apnsExpiration(nowMs: number): string {
  return String(Math.floor(nowMs / 1000) + NON_CRITICAL_PUSH_TTL_SECONDS);
}

/**
 * apns-priority 10 delivers promptly (an out-of-service notice should not wait for a
 * power-opportune window); promptness is not criticality — the payload above decides how the
 * notification presents. The collapse id is the idempotency key hashed (64 hex chars, inside
 * APNs's 64-byte cap), so only a redelivery of the same send coalesces.
 */
export function nonCriticalApnsHeaders(
  push: NonCriticalPush,
  nowMs: number,
): Record<string, string> {
  return {
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': apnsExpiration(nowMs),
    'apns-id': apnsIdFor(push.idempotencyKey),
    'apns-collapse-id': createHash('sha256').update(push.idempotencyKey).digest('hex'),
  };
}

/**
 * FCM HTTP v1 request. Android gets a NORMAL-priority **data-only** message: the app's
 * background handler posts it itself on the DEFAULT channel (pushNotificationDisplay.ts routes
 * `category: 'digest'` there), so no `notification` block and no HIGH priority. The `apns`
 * block covers an iOS device still on a legacy FCM token, with the same non-critical payload.
 */
export function buildNonCriticalFcmRequest(
  push: NonCriticalPush,
  token: string,
  nowMs: number,
): Record<string, unknown> {
  return {
    message: {
      token,
      data: nonCriticalDataFields(push),
      android: { priority: 'NORMAL', ttl: `${NON_CRITICAL_PUSH_TTL_SECONDS}s` },
      apns: {
        headers: nonCriticalApnsHeaders(push, nowMs),
        payload: buildNonCriticalApnsPayload(push),
      },
    },
  };
}
