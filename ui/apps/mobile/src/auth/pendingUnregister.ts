import type { AuthConfiguration, RefreshResult } from 'react-native-app-auth';
import Config from 'react-native-config';
import * as Keychain from 'react-native-keychain';
import { revokePushToken } from '../features/alerts/pushTokens';
import { ApiError } from '../lib/apiClient';

/**
 * A sign-out whose push revoke did not land (M3): no signal, or the server refused it. Until the
 * DELETE reaches the server, this phone keeps ringing - full screen, through Do Not Disturb - for
 * a member who is no longer signed in to it. The record is kept, in the keychain because it holds
 * that member's refresh token, and retried whenever signal returns; the refresh token is held only
 * for this, and dropped once the revoke lands, the token is refused, or the record is too old.
 *
 * One record per member (N-m1): A's revoke pending when B signs out offline must not be lost.
 * Stored THIS_DEVICE_ONLY so it never travels in a backup or a device transfer, and once a revoke
 * lands (or is given up) the refresh token is revoked at Cognito as well.
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
  /** Revokes a refresh token at the identity provider; defaults to Cognito's /oauth2/revoke. */
  revokeRefreshToken?: (refreshToken: string) => Promise<void>;
}

const PENDING_SERVER = 'boxalarm-pending-unregister';

/** After this the record is dropped: a refresh token is not kept on the phone indefinitely. */
export const PENDING_UNREGISTER_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** How long signing in waits for a pending revoke already being sent (N-m3). */
export const CANCEL_WAIT_MS = 5_000;

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

/**
 * Cognito's token revocation (a public client: client_id, no secret). Best-effort: a failure is
 * logged, and the token then lapses only when Cognito expires it.
 */
export async function revokeRefreshTokenAtCognito(refreshToken: string): Promise<void> {
  const origin = Config.COGNITO_HOSTED_UI_ORIGIN;
  const clientId = Config.COGNITO_NATIVE_CLIENT_ID;
  if (!origin || !clientId) return;
  const response = await fetch(`${origin.replace(/\/$/, '')}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, client_id: clientId }).toString(),
  });
  if (!response.ok) throw new Error(`token revocation answered ${response.status}`);
}

async function readAll(deps: PendingUnregisterDeps): Promise<PendingUnregister[]> {
  const creds = await deps.getInternetCredentials(PENDING_SERVER);
  if (!creds) return [];
  try {
    const parsed: unknown = JSON.parse(creds.password);
    // A single record: written by the first build of this (one slot).
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(isPendingUnregister);
  } catch {
    return [];
  }
}

async function writeAll(deps: PendingUnregisterDeps, list: PendingUnregister[]): Promise<void> {
  if (list.length === 0) {
    await deps.resetInternetCredentials({ server: PENDING_SERVER });
    return;
  }
  await deps.setInternetCredentials(PENDING_SERVER, PENDING_SERVER, JSON.stringify(list), {
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

// Read-modify-write of the one keychain item, serialised within this process.
let queue: Promise<unknown> = Promise.resolve();
function update<T>(
  deps: PendingUnregisterDeps,
  change: (list: PendingUnregister[]) => { next: PendingUnregister[] | null; result: T },
): Promise<T> {
  const run = queue.then(async () => {
    const { next, result } = change(await readAll(deps));
    if (next) await writeAll(deps, next);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function readPendingUnregisters(
  deps: PendingUnregisterDeps,
): Promise<PendingUnregister[]> {
  await queue;
  return readAll(deps);
}

/**
 * Members whose pending revoke was cancelled by their own sign-in (N-m3). Kept for the rest of
 * that sign-in (R2-M1): a retry that had already started reading the pending list - not yet
 * tracked per member - must still find the cancellation before its DELETE. Cleared only when a
 * new pending revoke is saved for the member (their next sign-out that could not reach the
 * server).
 */
const cancelled = new Set<string>();

/** Keeps (or replaces) the member's pending revoke. */
export async function savePendingUnregister(
  deps: PendingUnregisterDeps,
  pending: PendingUnregister,
): Promise<void> {
  // A new sign-out of this member: whatever cancelled their earlier revoke is over (R2-M1).
  cancelled.delete(pending.memberId);
  await writePending(deps, pending);
}

async function writePending(deps: PendingUnregisterDeps, pending: PendingUnregister) {
  await update(deps, (list) => ({
    next: [...list.filter((p) => p.memberId !== pending.memberId), pending],
    result: undefined,
  }));
}

/** Removes the member's record; true if there was one. */
function removePending(deps: PendingUnregisterDeps, memberId: string): Promise<boolean> {
  return update(deps, (list) => {
    const next = list.filter((p) => p.memberId !== memberId);
    return next.length === list.length ? { next: null, result: false } : { next, result: true };
  });
}

/**
 * - none: nothing was pending
 * - done: every pending revoke landed; this phone is no longer paged for those members
 * - failed: at least one is still pending (no signal, or the identity provider or API could not
 *   be reached)
 * - dropped: given up on - the refresh token was refused, the member is gone, or the record expired
 */
export type PendingUnregisterOutcome = 'none' | 'done' | 'failed' | 'dropped';

const inFlightFor = new Map<string, Promise<PendingUnregisterOutcome>>();
let inFlight: Promise<PendingUnregisterOutcome> | null = null;

async function retryOne(
  deps: PendingUnregisterDeps,
  config: AuthConfiguration,
  pending: PendingUnregister,
  now: () => number,
): Promise<PendingUnregisterOutcome> {
  const revokeAtIdp = (token: string) =>
    (deps.revokeRefreshToken ?? revokeRefreshTokenAtCognito)(token).catch((error: unknown) =>
      console.warn('[auth] revoking the signed-out refresh token failed', error),
    );
  const drop = async (reason: string, token: string | null): Promise<PendingUnregisterOutcome> => {
    console.warn(`[push] giving up the pending sign-out revoke: ${reason}`);
    await removePending(deps, pending.memberId).catch(() => false);
    if (token) await revokeAtIdp(token);
    return 'dropped';
  };
  if (now() - pending.savedAt > PENDING_UNREGISTER_MAX_AGE_MS) {
    return drop('too old', pending.refreshToken);
  }

  let accessToken: string;
  let refreshToken = pending.refreshToken;
  try {
    const result = await deps.refresh(config, { refreshToken });
    accessToken = result.accessToken;
    if (result.refreshToken && result.refreshToken !== refreshToken) {
      refreshToken = result.refreshToken;
      // Never re-creates a record the member's sign-in has cancelled.
      if (!cancelled.has(pending.memberId)) {
        await writePending(deps, { ...pending, refreshToken });
      }
    }
  } catch (error) {
    if (isInvalidGrant(error)) return drop('the refresh token was refused', null);
    return 'failed';
  }
  // The member signed back in on this phone meanwhile: their registration re-added this device,
  // so this DELETE must not be sent (N-m3).
  if (cancelled.has(pending.memberId)) return 'none';
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
    if (status === 403 || status === 404)
      return drop(`the server answered ${status}`, refreshToken);
    return 'failed';
  }
  await removePending(deps, pending.memberId).catch(() => false);
  await revokeAtIdp(refreshToken);
  return 'done';
}

/** One attempt at every pending revoke; concurrent callers share it. Never throws. */
export function retryPendingUnregister(
  deps: PendingUnregisterDeps,
  config: AuthConfiguration,
  now: () => number = Date.now,
): Promise<PendingUnregisterOutcome> {
  inFlight ??= (async (): Promise<PendingUnregisterOutcome> => {
    const list = await readPendingUnregisters(deps).catch(() => []);
    if (list.length === 0) return 'none';
    const outcomes = await Promise.all(
      list
        .filter((pending) => !cancelled.has(pending.memberId))
        .map((pending) => {
          const one = retryOne(deps, config, pending, now).catch(
            (): PendingUnregisterOutcome => 'failed',
          );
          inFlightFor.set(pending.memberId, one);
          return one.finally(() => inFlightFor.delete(pending.memberId));
        }),
    );
    if (outcomes.includes('failed')) return 'failed';
    if (outcomes.includes('dropped')) return 'dropped';
    return outcomes.includes('done') ? 'done' : 'none';
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The same member signing in again on this phone: their registration re-adds this device, so a
 * revoke still pending must not land after it and remove it (N-m3). The record is removed first
 * and a retry that has not yet sent its DELETE sees the cancellation; one already sending is
 * waited for, at most CANCEL_WAIT_MS, so a stalled link cannot hold up sign-in. The refresh token
 * it held is revoked at Cognito.
 */
export async function cancelPendingUnregisterFor(
  memberId: string,
  deps: PendingUnregisterDeps,
): Promise<void> {
  cancelled.add(memberId);
  const sending = inFlightFor.get(memberId);
  const list = await readPendingUnregisters(deps).catch(() => []);
  const mine = list.find((p) => p.memberId === memberId);
  await removePending(deps, memberId).catch(() => false);
  if (sending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sending.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CANCEL_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  if (mine) {
    await (deps.revokeRefreshToken ?? revokeRefreshTokenAtCognito)(mine.refreshToken).catch(
      () => undefined,
    );
  }
}
