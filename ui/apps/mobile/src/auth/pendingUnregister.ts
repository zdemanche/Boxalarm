import type { AuthConfiguration, RefreshResult } from 'react-native-app-auth';
import * as Keychain from 'react-native-keychain';
import { revokePushToken } from '../features/alerts/pushTokens';
import { ApiError } from '../lib/apiClient';

/**
 * A sign-out whose push revoke did not land (M3): no signal, or the server refused it. Until the
 * DELETE reaches the server, this phone keeps ringing - full screen, through Do Not Disturb - for
 * a member who is no longer signed in to it. The record is kept, in the keychain because it holds
 * that member's refresh token, and retried whenever signal returns; the refresh token is held only
 * for this, and dropped once the revoke lands, the token is refused, or the record is too old.
 */
export interface PendingUnregister {
  readonly memberId: string;
  readonly deviceId: string;
  readonly refreshToken: string;
  readonly apiBaseUrl: string;
  /** Epoch ms. */
  readonly savedAt: number;
}

/** The keychain operations and token refresh this needs (a subset of AuthContext's AuthDeps). */
export interface PendingUnregisterDeps {
  refresh: (config: AuthConfiguration, params: { refreshToken: string }) => Promise<RefreshResult>;
  setInternetCredentials: typeof Keychain.setInternetCredentials;
  getInternetCredentials: typeof Keychain.getInternetCredentials;
  resetInternetCredentials: typeof Keychain.resetInternetCredentials;
}

const PENDING_SERVER = 'boxalarm-pending-unregister';

/** After this the record is dropped: a refresh token is not kept on the phone indefinitely. */
export const PENDING_UNREGISTER_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function isInvalidGrant(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'invalid_grant'
  );
}

function isPendingUnregister(value: unknown): value is PendingUnregister {
  const v = value as Partial<PendingUnregister> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.memberId === 'string' &&
    typeof v.deviceId === 'string' &&
    typeof v.refreshToken === 'string' &&
    typeof v.apiBaseUrl === 'string' &&
    typeof v.savedAt === 'number'
  );
}

export async function readPendingUnregister(
  deps: PendingUnregisterDeps,
): Promise<PendingUnregister | null> {
  const creds = await deps.getInternetCredentials(PENDING_SERVER);
  if (!creds) return null;
  try {
    const parsed: unknown = JSON.parse(creds.password);
    return isPendingUnregister(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePendingUnregister(
  deps: PendingUnregisterDeps,
  pending: PendingUnregister,
): Promise<void> {
  await deps.setInternetCredentials(PENDING_SERVER, PENDING_SERVER, JSON.stringify(pending), {
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
  });
}

async function clearPendingUnregister(deps: PendingUnregisterDeps): Promise<void> {
  await deps.resetInternetCredentials({ server: PENDING_SERVER });
}

/**
 * - none: nothing was pending
 * - done: the revoke landed; this phone is no longer paged for that member
 * - failed: still pending (no signal, or the identity provider or API could not be reached)
 * - dropped: given up - the refresh token was refused, the member is gone, or the record expired
 */
export type PendingUnregisterOutcome = 'none' | 'done' | 'failed' | 'dropped';

let inFlight: Promise<PendingUnregisterOutcome> | null = null;

/** One attempt at the pending revoke; concurrent callers share it. Never throws. */
export function retryPendingUnregister(
  deps: PendingUnregisterDeps,
  config: AuthConfiguration,
  now: () => number = Date.now,
): Promise<PendingUnregisterOutcome> {
  inFlight ??= (async (): Promise<PendingUnregisterOutcome> => {
    const pending = await readPendingUnregister(deps).catch(() => null);
    if (!pending) return 'none';
    const drop = async (reason: string): Promise<PendingUnregisterOutcome> => {
      console.warn(`[push] giving up the pending sign-out revoke: ${reason}`);
      await clearPendingUnregister(deps).catch(() => undefined);
      return 'dropped';
    };
    if (now() - pending.savedAt > PENDING_UNREGISTER_MAX_AGE_MS) return drop('too old');

    let accessToken: string;
    try {
      const result = await deps.refresh(config, { refreshToken: pending.refreshToken });
      accessToken = result.accessToken;
      if (result.refreshToken && result.refreshToken !== pending.refreshToken) {
        await savePendingUnregister(deps, { ...pending, refreshToken: result.refreshToken });
      }
    } catch (error) {
      if (isInvalidGrant(error)) return drop('the refresh token was refused');
      return 'failed';
    }
    try {
      await revokePushToken(
        pending.memberId,
        { getAccessToken: async () => accessToken, renewSilently: async () => null },
        pending.apiBaseUrl,
        pending.deviceId,
      );
    } catch (error) {
      // 403/404: the member no longer exists here or the path is not theirs - nothing to revoke.
      const status = error instanceof ApiError ? error.problem.status : null;
      if (status === 403 || status === 404) return drop(`the server answered ${status}`);
      return 'failed';
    }
    await clearPendingUnregister(deps).catch(() => undefined);
    return 'done';
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The same member signing in again on this phone: their registration re-adds this device, so a
 * revoke still pending must not land after it and remove it. Waits for one in flight first.
 */
export async function cancelPendingUnregisterFor(
  memberId: string,
  deps: PendingUnregisterDeps,
): Promise<void> {
  await inFlight?.catch(() => undefined);
  const pending = await readPendingUnregister(deps).catch(() => null);
  if (pending?.memberId === memberId) await clearPendingUnregister(deps).catch(() => undefined);
}
