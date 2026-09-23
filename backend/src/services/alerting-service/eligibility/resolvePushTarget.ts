export const NO_TOKEN_REGISTERED_REASON = 'push: no token registered';

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly platform?: string;
  readonly token?: string;
  readonly valid?: boolean;
}

export type ResolvePushTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly token: string; readonly platform: string };

export function resolvePushTarget(
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolvePushTargetResult {
  const entry = (contactChannels ?? []).find(
    (channel) => channel.channel === 'PUSH' && channel.valid !== false,
  );
  if (!entry?.token || !entry.platform) {
    return { skipped: true, reason: NO_TOKEN_REGISTERED_REASON };
  }
  return { skipped: false, token: entry.token, platform: entry.platform };
}
