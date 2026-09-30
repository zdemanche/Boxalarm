import { createHash } from 'node:crypto';
import type { ApnsInterruptionLevel } from './pushCredentials.js';

/**
 * One push send, platform-neutral. `idempotencyKey` is the send guard's exactly-once key
 * (`{dispatchId}#{toneSequence}#{memberId}#PUSH`, or the MUTUALAID form for an officer prompt);
 * `collapseKey` is the per-tone notification identity (`{dispatchId}#{toneSequence}`,
 * architecture §5.1 B4) so a tone-2 re-page is never coalesced into tone 1 on the device.
 */
export interface PushNotification {
  readonly token: string;
  readonly alertKind: 'dispatch' | 'mutual_aid_prompt';
  readonly dispatchId: string;
  readonly toneSequence?: number | undefined;
  readonly title: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly collapseKey: string;
  /** The dispatch's own fields, sent as their own keys so the app need not parse `body`. */
  readonly alert?: PushAlertFields | undefined;
  /**
   * A self-test/canary push. It reaches the real device through the real gateway, so it is
   * labelled: the title says TEST and the data carries `test: "true"`.
   */
  readonly isTest?: boolean | undefined;
}

export const TEST_TITLE_PREFIX = 'TEST — ';

export interface PushAlertFields {
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets?: string | undefined;
  /** Epoch seconds. */
  readonly dispatchedAt?: number | undefined;
}

/**
 * APNs refuses a payload over 4096 bytes (PayloadTooLarge) - a refusal that would retry into
 * the DLQ and never page. Ingress does not cap the dispatch text, so every free-text value is
 * bounded here in UTF-8 bytes; with these caps the largest possible payload stays well under
 * 4 KB (pushPayload.test.ts checks the worst case).
 */
export const PUSH_TEXT_MAX_BYTES = {
  title: 128,
  body: 512,
  incidentType: 128,
  address: 256,
  crossStreets: 256,
} as const;

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
 * Every alerting-plane push is a dispatch-class alert. The mobile app routes anything but
 * `category: 'digest'` to its critical `dispatch-critical` channel (ui/apps/mobile
 * pushChannel.ts); the officer mutual-aid prompt is critical too — the architecture reserves
 * the non-critical channel for the LOB-plane notification service, never for this worker.
 */
export const PUSH_CATEGORY = 'dispatch';

/**
 * How long APNs and FCM keep trying to reach an offline phone. The default is up to four weeks,
 * so a phone that comes back hours later would ring critically, through Do Not Disturb, for a
 * call long over. On Android, which has no collapse, all three tones would arrive in one burst.
 * Ten minutes covers the whole default tone ladder (tone 2 at T+180s, tone 3 at T+360s) with
 * margin. A page that cannot reach the phone within that window is no longer actionable; SMS
 * and voice run in parallel for exactly that case.
 */
export const PUSH_TTL_SECONDS = 600;

/** Absolute APNs expiry (epoch seconds) for a push sent at `nowMs`. */
export function apnsExpiration(nowMs: number): string {
  return String(Math.floor(nowMs / 1000) + PUSH_TTL_SECONDS);
}

/**
 * The iOS notification category (UNNotificationCategory identifier) a dispatch alert carries in
 * `aps.category`. The app registers its RESPONDING / NOT RESPONDING action buttons under it; an
 * alert without it shows no actions. The officer mutual-aid prompt is not a dispatch alert and
 * does not carry it.
 */
export const APNS_DISPATCH_CATEGORY = 'DISPATCH';

/** Bundled critical-alert sound; `default` is the system sound. */
export const APNS_CRITICAL_SOUND_NAME = 'default';

const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/** APNs caps apns-collapse-id at 64 bytes; hash a longer one rather than truncate it. */
export function apnsCollapseId(collapseKey: string): string {
  return Buffer.byteLength(collapseKey) <= APNS_COLLAPSE_ID_MAX_BYTES
    ? collapseKey
    : createHash('sha256').update(collapseKey).digest('hex');
}

/**
 * apns-id must be a UUID. Derived from the exactly-once key (name-based, RFC 9562 v8 layout
 * over SHA-256) so a redelivered send of the same page carries the same id — APNs and device
 * logs then show one notification, re-attempted.
 */
export function apnsIdFor(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `incidentType`, `address`, `crossStreets`, `dispatchedAt` as their own keys (APNs custom keys
 * and FCM data): the app prefers them to parsing "{type} — {address}" out of `body`. Absent
 * optional fields are omitted, never sent empty. FCM data values must be strings.
 */
function alertFields(notification: PushNotification): Record<string, string> {
  const alert = notification.alert;
  if (!alert) {
    return {};
  }
  return {
    incidentType: truncateUtf8(alert.incidentType, PUSH_TEXT_MAX_BYTES.incidentType),
    address: truncateUtf8(alert.address, PUSH_TEXT_MAX_BYTES.address),
    ...(alert.crossStreets
      ? { crossStreets: truncateUtf8(alert.crossStreets, PUSH_TEXT_MAX_BYTES.crossStreets) }
      : {}),
    ...(alert.dispatchedAt !== undefined ? { dispatchedAt: String(alert.dispatchedAt) } : {}),
  };
}

function routingFields(notification: PushNotification): Record<string, string> {
  return {
    category: PUSH_CATEGORY,
    alertKind: notification.alertKind,
    dispatchId: notification.dispatchId,
    ...(notification.toneSequence !== undefined
      ? { toneSequence: String(notification.toneSequence) }
      : {}),
    ...alertFields(notification),
    ...(notification.isTest ? { test: 'true' } : {}),
  };
}

function boundedTitle(notification: PushNotification): string {
  const title = notification.isTest
    ? `${TEST_TITLE_PREFIX}${notification.title}`
    : notification.title;
  return truncateUtf8(title, PUSH_TEXT_MAX_BYTES.title);
}

function boundedBody(notification: PushNotification): string {
  return truncateUtf8(notification.body, PUSH_TEXT_MAX_BYTES.body);
}

/**
 * Custom keys the app reads (pushRouting.ts / pushNotificationDisplay.ts): `category`,
 * `dispatchId`, `title`, `body`, and the dispatch's own fields (alertFields). FCM data values
 * must be strings.
 */
export function pushDataFields(notification: PushNotification): Record<string, string> {
  return {
    ...routingFields(notification),
    title: boundedTitle(notification),
    body: boundedBody(notification),
  };
}

/**
 * `critical` needs Apple's Critical Alerts entitlement (issue #4) plus the member's permission.
 * Without it iOS does not give the alert critical treatment. Until #4 is granted, set the APNs
 * secret's `interruptionLevel` to `time-sensitive`. That level needs the Time Sensitive
 * Notifications entitlement (`com.apple.developer.usernotifications.time-sensitive`), which is
 * self-serve and is in ios/Boxalarm/Boxalarm.entitlements; the capability must also be enabled
 * on the App ID. A time-sensitive alert breaks through Focus (unless the member turns that off
 * for the app) and plays the default sound, but does not override the ring/silent switch.
 * Neither level has been verified on a device yet; check both in Sleep Focus before relying on
 * them.
 */
export function buildApnsPayload(
  notification: PushNotification,
  interruptionLevel: ApnsInterruptionLevel,
): Record<string, unknown> {
  return {
    aps: {
      alert: { title: boundedTitle(notification), body: boundedBody(notification) },
      sound:
        interruptionLevel === 'critical'
          ? { critical: 1, name: APNS_CRITICAL_SOUND_NAME, volume: 1 }
          : APNS_CRITICAL_SOUND_NAME,
      'interruption-level': interruptionLevel,
      // Lets the Notification Service Extension (architecture §5.1) enrich the alert.
      'mutable-content': 1,
      // A test push has no Responding / Not responding actions to offer (review R2-m4), but
      // keeps the interruption level and sound above: it proves the alarm actually sounds.
      ...(notification.alertKind === 'dispatch' && !notification.isTest
        ? { category: APNS_DISPATCH_CATEGORY }
        : {}),
    },
    ...routingFields(notification),
  };
}
