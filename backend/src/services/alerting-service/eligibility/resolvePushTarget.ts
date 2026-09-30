import { createHash } from 'node:crypto';

export const NO_TOKEN_REGISTERED_REASON = 'push: no token registered';

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly phoneNumber?: string;
  readonly valid?: boolean;
  /**
   * PUSH only: the app installation that registered the token (registerToken.ts). A member
   * has one PUSH entry per device; entries registered before multi-device support carry none.
   */
  readonly deviceId?: string;
  /** PUSH, iOS only: the token's APNs environment (`development` | `production`, default). */
  readonly apnsEnvironment?: string;
}

export type ContactChannelKey = 'PUSH' | 'SMS' | 'VOICE';

/**
 * The one contact lookup shared by the producers (fan-out, tone evaluator, mutual-aid port),
 * which decide what to publish, and the channel worker (channels/channelEnvelope.ts), which
 * resolves where to send. Two lookups drifted apart before: when the producer is stricter it
 * never publishes and nothing errors - the silent direction of the SMS-never-sends defect
 * (#12). Case-insensitive, and a malformed entry (no channel string) is ignored rather than
 * thrown on, which would fail the member's whole evaluation on every retry.
 */
export function findContactEntry<
  T extends { readonly channel?: unknown; readonly valid?: boolean },
>(contactChannels: readonly T[] | undefined, key: ContactChannelKey): T | undefined {
  return (contactChannels ?? []).find(
    (candidate) =>
      typeof candidate?.channel === 'string' &&
      candidate.channel.toUpperCase() === key &&
      candidate.valid !== false,
  );
}

/**
 * A phone entry's number: `phoneNumber`, as the snapshot's phone projection writes it
 * (eligibility/contactProjection.ts), or `token` for the legacy `{ channel: 'sms', token }`
 * shape an earlier, never-deployed writer used.
 */
export function contactPhone(
  entry: { readonly phoneNumber?: string; readonly token?: string } | undefined,
): string | undefined {
  return entry?.phoneNumber ?? entry?.token;
}

export type ResolvePushTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly token: string; readonly platform?: string };

export interface PushDeviceTarget {
  readonly token: string;
  readonly platform?: string;
  /** `development` for a development-signed iOS build; otherwise production. */
  readonly apnsEnvironment?: 'development' | 'production';
  /** Stable per device: the installation id, else a digest of the token (legacy entries). */
  readonly deviceKey: string;
}

/**
 * Every valid device a push page goes to: one per PUSH entry with a token, duplicates of the
 * same token collapsed. The producers only ask whether there is at least one
 * (resolvePushTarget); the push worker sends to all of them under the one per-channel receipt
 * (channels/deliverChannelMessage.ts) - a member signed in on a phone and a tablet is paged on
 * both.
 */
export function resolvePushTargets(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): PushDeviceTarget[] {
  const seen = new Set<string>();
  const targets: PushDeviceTarget[] = [];
  for (const entry of contactChannels ?? []) {
    if (
      typeof entry?.channel !== 'string' ||
      entry.channel.toUpperCase() !== 'PUSH' ||
      entry.valid === false ||
      typeof entry.token !== 'string' ||
      entry.token.length === 0 ||
      seen.has(entry.token)
    ) {
      continue;
    }
    seen.add(entry.token);
    targets.push({
      token: entry.token,
      ...(entry.platform ? { platform: entry.platform } : {}),
      ...(entry.apnsEnvironment === 'development' || entry.apnsEnvironment === 'production'
        ? { apnsEnvironment: entry.apnsEnvironment }
        : {}),
      deviceKey:
        typeof entry.deviceId === 'string' && entry.deviceId.length > 0
          ? entry.deviceId
          : `token-${createHash('sha256').update(entry.token).digest('hex').slice(0, 16)}`,
    });
  }
  return targets;
}

/** A PUSH entry's token - `platform` is informational; the worker never needed it to send. */
export function resolvePushTarget(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolvePushTargetResult {
  // The same device list the push worker sends to: publish when at least one device exists.
  const [first] = resolvePushTargets(contactChannels);
  if (!first) {
    return { skipped: true, reason: NO_TOKEN_REGISTERED_REASON };
  }
  return {
    skipped: false,
    token: first.token,
    ...(first.platform ? { platform: first.platform } : {}),
  };
}

export const NO_SMS_NUMBER_REASON = 'sms: no number registered';

export type ResolveSmsTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly number: string };

export function resolveSmsTarget(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolveSmsTargetResult {
  const number = contactPhone(findContactEntry(contactChannels, 'SMS'));
  if (!number) {
    return { skipped: true, reason: NO_SMS_NUMBER_REASON };
  }
  return { skipped: false, number };
}
