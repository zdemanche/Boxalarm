import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import {
  authorize as defaultAuthorize,
  refresh as defaultRefresh,
  type AuthConfiguration,
  type AuthorizeResult,
  type RefreshResult,
} from 'react-native-app-auth';
import Config from 'react-native-config';
import * as Keychain from 'react-native-keychain';
import type { AuthTokenSource } from '../lib/apiClient';
import { getDeviceInstallationId } from '../features/alerts/deviceInstallationId';
import { revokePushToken } from '../features/alerts/pushTokens';
import { buildOidcConfig } from './config';
import {
  cancelPendingUnregisterFor,
  isInvalidGrant,
  retryPendingUnregister as retryPendingUnregisterWith,
  savePendingUnregister,
  type PendingUnregisterOutcome,
} from './pendingUnregister';
import { kvDelete, kvSet } from '../sync/kvStore';
import * as syncManager from '../sync/syncManager';
import { clearMemberCache, LAST_SESSION_SUB_KEY } from '../sync/memberCache';

/** How long sign-out waits for one last try at sending queued work (alert answers first). */
const SIGN_OUT_DRAIN_MS = 3000;

const KEYCHAIN_SERVER = 'boxalarm-auth';
const FOREGROUND_RENEWAL_WINDOW_MS = 5 * 60_000;

export type Role = 'MEMBER' | 'OFFICER' | 'TRAINING' | 'APPARATUS' | 'ADMIN' | 'CHIEF';

const KNOWN_ROLES: readonly Role[] = [
  'MEMBER',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'ADMIN',
  'CHIEF',
];

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpirationDate: string;
  idToken: string;
}

function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function decodeRoles(idToken: string): Role[] {
  const claims = decodeIdTokenClaims(idToken);
  const groups = claims['cognito:groups'];
  if (!Array.isArray(groups)) return ['MEMBER'];
  const roles = groups
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.toUpperCase())
    .filter((role): role is Role => KNOWN_ROLES.includes(role as Role));
  return roles.length > 0 ? roles : ['MEMBER'];
}

function decodeMemberId(idToken: string): string | null {
  const sub = decodeIdTokenClaims(idToken).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

/** The member's department (custom:deptId, the claim the backend authorizer scopes by). */
function decodeDeptId(idToken: string): string | null {
  const deptId = decodeIdTokenClaims(idToken)['custom:deptId'];
  return typeof deptId === 'string' && deptId.length > 0 ? deptId : null;
}

function msUntilExpiry(tokens: StoredTokens): number {
  const expiry = new Date(tokens.accessTokenExpirationDate).getTime();
  return Number.isNaN(expiry) ? -Infinity : expiry - Date.now();
}

function isExpired(tokens: StoredTokens): boolean {
  return msUntilExpiry(tokens) <= 0;
}

function isNearExpiry(tokens: StoredTokens): boolean {
  return msUntilExpiry(tokens) <= FOREGROUND_RENEWAL_WINDOW_MS;
}

export interface AuthDeps {
  authorize: (config: AuthConfiguration) => Promise<AuthorizeResult>;
  refresh: (config: AuthConfiguration, params: { refreshToken: string }) => Promise<RefreshResult>;
  setInternetCredentials: typeof Keychain.setInternetCredentials;
  getInternetCredentials: typeof Keychain.getInternetCredentials;
  resetInternetCredentials: typeof Keychain.resetInternetCredentials;
}

const defaultDeps: AuthDeps = {
  authorize: defaultAuthorize,
  refresh: defaultRefresh,
  setInternetCredentials: Keychain.setInternetCredentials,
  getInternetCredentials: Keychain.getInternetCredentials,
  resetInternetCredentials: Keychain.resetInternetCredentials,
};

/**
 * Retries a sign-out's push revoke that did not land (M3, pendingUnregister). The provider runs it
 * on launch, on every return to the foreground and whenever the network comes back; the sign-out
 * dialog's Retry runs it at once.
 */
export function retryPendingUnregister(
  deps: AuthDeps = defaultDeps,
): Promise<PendingUnregisterOutcome> {
  return retryPendingUnregisterWith(deps, buildOidcConfig());
}

async function readStoredTokens(deps: AuthDeps): Promise<StoredTokens | null> {
  const creds = await deps.getInternetCredentials(KEYCHAIN_SERVER);
  if (!creds) return null;
  try {
    return JSON.parse(creds.password) as StoredTokens;
  } catch {
    return null;
  }
}

async function writeStoredTokens(deps: AuthDeps, tokens: StoredTokens): Promise<void> {
  await deps.setInternetCredentials(KEYCHAIN_SERVER, KEYCHAIN_SERVER, JSON.stringify(tokens), {
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
  });
}

/**
 * Which sign-in the phone is on (M4). signIn and signOut move it on; a token refresh started under
 * one value must not write the keychain or re-apply tokens once it has changed - a refresh that
 * resolves after sign-out would otherwise sign the member back in (and they would not be paged,
 * their push entry having been revoked), or overwrite the next member's keychain with theirs.
 * Module-level so the provider and the headless token source share it within one JS process.
 */
let sessionEpoch = 0;
const inFlightRenewals = new Set<Promise<unknown>>();

function beginSessionChange(): void {
  sessionEpoch += 1;
}

/** How long signIn/signOut wait for a refresh already in flight (a weak link can stall one). */
const SETTLE_RENEWALS_MS = 5000;

/**
 * Waits (bounded) for every refresh already in flight, so none writes the keychain after this.
 * One still running past the bound finds the epoch moved at its compare-and-swap and writes
 * nothing.
 */
async function settleRenewals(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...inFlightRenewals].map((renewal) => renewal.catch(() => undefined))),
    new Promise((resolve) => {
      timer = setTimeout(resolve, SETTLE_RENEWALS_MS);
    }),
  ]);
  clearTimeout(timer);
}

function trackRenewal<T>(renewal: Promise<T>): Promise<T> {
  inFlightRenewals.add(renewal);
  void renewal
    .catch(() => undefined)
    .finally(() => {
      inFlightRenewals.delete(renewal);
    });
  return renewal;
}

type RenewOutcome =
  | { kind: 'renewed'; tokens: StoredTokens }
  | { kind: 'noSession' }
  /** Signed out, signed in again, or renewed elsewhere while this refresh was in flight. */
  | { kind: 'superseded' }
  /** The refresh token was refused (invalid_grant), and it is still the session on the phone. */
  | { kind: 'invalidGrant' };

/**
 * One refresh of the stored session, written back only if that session is still the one on the
 * phone: the epoch has not moved and the keychain still holds the refresh token this refresh
 * used (compare-and-swap, M4). Throws a refresh error other than invalid_grant.
 */
async function renewStoredSession(
  deps: AuthDeps,
  config: AuthConfiguration,
): Promise<RenewOutcome> {
  const epoch = sessionEpoch;
  const stored = await readStoredTokens(deps);
  if (!stored) return { kind: 'noSession' };
  const stillCurrent = async () => {
    if (epoch !== sessionEpoch) return false;
    const now = await readStoredTokens(deps).catch(() => null);
    return epoch === sessionEpoch && now?.refreshToken === stored.refreshToken;
  };
  let result: RefreshResult;
  try {
    result = await deps.refresh(config, { refreshToken: stored.refreshToken });
  } catch (error) {
    if (isInvalidGrant(error)) {
      return (await stillCurrent()) ? { kind: 'invalidGrant' } : { kind: 'superseded' };
    }
    throw error;
  }
  if (!(await stillCurrent())) return { kind: 'superseded' };
  const next: StoredTokens = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? stored.refreshToken,
    accessTokenExpirationDate: result.accessTokenExpirationDate,
    idToken: result.idToken,
  };
  await writeStoredTokens(deps, next);
  // signIn/signOut wait for this refresh before touching the keychain, so the write above cannot
  // land after theirs; but if the session changed meanwhile, the new tokens must not be applied.
  return epoch === sessionEpoch ? { kind: 'renewed', tokens: next } : { kind: 'superseded' };
}

/**
 * A token source that works with no React tree - for headless JS (an Android notification
 * action answered from the lock screen while the app is not running). Reads the same keychain
 * entry as AuthProvider and renews it the same way; never signs anyone out (an invalid refresh
 * token just yields null, and the answer stays queued for the next session).
 */
export interface StoredSessionOwner {
  readonly memberId: string;
  readonly deptId: string | null;
}

/**
 * Who the stored session belongs to (id token sub and custom:deptId), read straight from the
 * keychain - for code with no AuthProvider (the headless notification task, a cold start before
 * the provider has loaded) that queues work and must stamp its owner (R3-C1). Null when there is
 * no stored session or the token has no sub.
 */
export async function readStoredSessionOwner(
  deps: AuthDeps = defaultDeps,
): Promise<StoredSessionOwner | null> {
  // A keychain read error is thrown, not reported as "no session": the caller must tell "signed
  // out" (refuse to queue an answer) from "couldn't read" (queue it with a hint) apart (R4-M1).
  const stored = await readStoredTokens(deps);
  if (!stored) return null;
  const memberId = decodeMemberId(stored.idToken);
  return memberId ? { memberId, deptId: decodeDeptId(stored.idToken) } : null;
}

/**
 * A token source that yields tokens only while the stored session is still `memberId`'s (m1):
 * the owner check is made on the same keychain read that supplies the token, and a renewal counts
 * only if the keychain then holds that member's session with that very token. A drain run sending
 * member A's row can then never go out with member B's token - not on the 401 retry, the
 * missing-ETA re-post or a photo re-create - even if B signs in mid-run: it gets no token, the
 * server answers 401, and the row stays A's.
 */
function tokensPinnedTo(
  memberId: string,
  deps: AuthDeps,
  renew: () => Promise<string | null>,
): AuthTokenSource {
  const renewPinned = async (): Promise<string | null> => {
    const token = await renew();
    if (!token) return null;
    const stored = await readStoredTokens(deps).catch(() => null);
    return stored && decodeMemberId(stored.idToken) === memberId && stored.accessToken === token
      ? token
      : null;
  };
  return {
    getAccessToken: async () => {
      const stored = await readStoredTokens(deps).catch(() => null);
      if (!stored || decodeMemberId(stored.idToken) !== memberId) return null;
      return isExpired(stored) ? renewPinned() : stored.accessToken;
    },
    renewSilently: renewPinned,
  };
}

export function createStoredTokenSource(deps: AuthDeps = defaultDeps) {
  let renewing: Promise<string | null> | null = null;
  const renewSilently = (): Promise<string | null> => {
    renewing ??= trackRenewal(
      (async () => {
        try {
          const outcome = await renewStoredSession(deps, buildOidcConfig());
          return outcome.kind === 'renewed' ? outcome.tokens.accessToken : null;
        } catch {
          return null;
        }
      })(),
    ).finally(() => {
      renewing = null;
    });
    return renewing;
  };
  return {
    getAccessToken: async (): Promise<string | null> => {
      const stored = await readStoredTokens(deps).catch(() => null);
      if (!stored) return null;
      return isExpired(stored) ? renewSilently() : stored.accessToken;
    },
    renewSilently,
    forMember: (memberId: string) => tokensPinnedTo(memberId, deps, renewSilently),
  };
}

interface AuthState {
  roles: Role[];
  memberId: string | null;
  /** Optional so test doubles needn't set it; the provider always does. */
  deptId?: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface SignOutResult {
  /**
   * False when this phone's push entry could not be removed (no signal, or refused): the phone
   * may still ring for the member until the revoke, kept pending, reaches the server (M3).
   */
  pushRevoked: boolean;
}

export interface AuthContextValue extends AuthState {
  signIn: () => Promise<void>;
  signOut: () => Promise<SignOutResult>;
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
  /**
   * A token source pinned to one member's session (m1): no token once it is not theirs. Optional
   * so test doubles needn't set it; the provider always does.
   */
  forMember?: (memberId: string) => AuthTokenSource;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Returns undefined outside AuthProvider — used by data hooks that degrade to mocks. */
export function useOptionalAuth(): AuthContextValue | undefined {
  return useContext(AuthContext);
}

export function AuthProvider({
  children,
  deps = defaultDeps,
}: {
  children: ReactNode;
  deps?: AuthDeps;
}) {
  const config = useMemo(() => buildOidcConfig(), []);
  const [state, setState] = useState<AuthState>({
    roles: [],
    memberId: null,
    isAuthenticated: false,
    isLoading: true,
  });
  const renewInFlightRef = useRef<Promise<string | null> | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const applyTokens = useCallback((tokens: StoredTokens | null) => {
    const sub = tokens ? decodeMemberId(tokens.idToken) : null;
    if (sub) void kvSet(LAST_SESSION_SUB_KEY, sub);
    else void kvDelete(LAST_SESSION_SUB_KEY);
    setState({
      roles: tokens ? decodeRoles(tokens.idToken) : [],
      memberId: tokens ? decodeMemberId(tokens.idToken) : null,
      deptId: tokens ? decodeDeptId(tokens.idToken) : null,
      isAuthenticated: tokens !== null,
      isLoading: false,
    });
  }, []);

  const renewSilently = useCallback((): Promise<string | null> => {
    if (renewInFlightRef.current) return renewInFlightRef.current;

    const attempt = trackRenewal(
      (async () => {
        const epoch = sessionEpoch;
        try {
          const outcome = await renewStoredSession(depsRef.current, config);
          if (outcome.kind === 'renewed') {
            applyTokens(outcome.tokens);
            return outcome.tokens.accessToken;
          }
          if (outcome.kind === 'noSession' && epoch === sessionEpoch) applyTokens(null);
          if (outcome.kind === 'invalidGrant') {
            await depsRef.current.resetInternetCredentials({ server: KEYCHAIN_SERVER });
            applyTokens(null);
          }
          return null;
        } catch {
          return null;
        }
      })(),
    );

    renewInFlightRef.current = attempt.finally(() => {
      renewInFlightRef.current = null;
    });
    return renewInFlightRef.current;
  }, [config, applyTokens]);

  useEffect(() => {
    let cancelled = false;

    readStoredTokens(depsRef.current)
      .then((stored) => {
        if (cancelled) return;
        applyTokens(stored);
        if (stored && isExpired(stored)) void renewSilently();
      })
      .catch(() => {
        // Startup: no known-good state exists yet, so unauthenticated is correct here.
        if (!cancelled) applyTokens(null);
      });

    const retryPending = () => void retryPendingUnregister(depsRef.current);
    retryPending();
    const unsubscribeNetInfo = NetInfo.addEventListener((net) => {
      if (net.isConnected === true) retryPending();
    });

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
      retryPending();
      readStoredTokens(depsRef.current)
        .then((stored) => {
          if (cancelled || !stored || !isNearExpiry(stored)) return;
          void renewSilently();
        })
        .catch(() => {
          // Foreground: a transient Keychain read failure must not destroy a known-good
          // authenticated session — leave existing state untouched.
        });
    });

    return () => {
      cancelled = true;
      subscription.remove();
      unsubscribeNetInfo?.();
    };
  }, [applyTokens, renewSilently]);

  const getAccessToken = useCallback(async () => {
    const stored = await readStoredTokens(depsRef.current);
    if (!stored) return null;
    return isExpired(stored) ? renewSilently() : stored.accessToken;
  }, [renewSilently]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn: async () => {
        const result = await depsRef.current.authorize(config);
        const tokens: StoredTokens = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          accessTokenExpirationDate: result.accessTokenExpirationDate,
          idToken: result.idToken,
        };
        // A refresh still running for the previous session must not overwrite these (M4).
        beginSessionChange();
        await settleRenewals();
        // Signing back in on a phone whose sign-out revoke never landed: this sign-in registers
        // the phone again, so that revoke must not land after it (M3).
        const signingIn = decodeMemberId(tokens.idToken);
        if (signingIn) {
          await cancelPendingUnregisterFor(signingIn, depsRef.current).catch(() => undefined);
        }
        await writeStoredTokens(depsRef.current, tokens);
        applyTokens(tokens);
      },
      signOut: async (): Promise<SignOutResult> => {
        // E1-S14-UI AC5: the DELETE must be sent before local credentials are cleared, so a
        // signed-out device stops receiving pages. Sign-out is never blocked by a network
        // failure - but a revoke that did not land is never silent either (M3).
        // While the session is still valid, one bounded try (about 3 s) to send this member's
        // queued work - an alert answer left behind waits until they sign in here again.
        await syncManager.drainBriefly(SIGN_OUT_DRAIN_MS).catch(() => undefined);
        const stored = await readStoredTokens(depsRef.current).catch(() => null);
        const apiBaseUrl = Config.API_BASE_URL;
        const memberId = stored ? decodeMemberId(stored.idToken) : null;
        let pushRevoked = true;
        if (stored && memberId && apiBaseUrl) {
          // The live session, renewal allowed: an access token past its hour is renewed rather
          // than sent stale and refused (M3).
          pushRevoked = await revokePushToken(
            memberId,
            tokensPinnedTo(memberId, depsRef.current, renewSilently),
            apiBaseUrl,
          ).then(
            () => true,
            (error: unknown) => {
              console.warn('[push] sign-out could not remove this phone from paging', error);
              return false;
            },
          );
          if (!pushRevoked) {
            // Held for that one purpose: retried whenever signal returns (a renewal above may
            // have rotated the refresh token, so it is read again).
            const latest = await readStoredTokens(depsRef.current).catch(() => null);
            const deviceId = await getDeviceInstallationId().catch(() => null);
            if (deviceId) {
              await savePendingUnregister(depsRef.current, {
                memberId,
                deviceId,
                refreshToken: (latest ?? stored).refreshToken,
                apiBaseUrl,
                savedAt: Date.now(),
              }).catch((error: unknown) =>
                console.error('[push] keeping the pending sign-out revoke failed', error),
              );
            }
          }
        }
        // The member's cached apparatus, shifts, check drafts and last mark-off stay on the phone
        // otherwise (review m8). Queued writes in the outbox are kept: they are the member's
        // work and sync once someone signs in.
        // From here on this session is over: a refresh still in flight is dropped rather than
        // writing the keychain back or signing the member in again, and is waited for so it
        // cannot land after the reset below (M4).
        beginSessionChange();
        await settleRenewals();
        if (memberId) await clearMemberCache(memberId).catch(() => undefined);
        // Before the keychain reset, so no window exists where the hint outlives the session.
        await kvDelete(LAST_SESSION_SUB_KEY);
        await depsRef.current.resetInternetCredentials({ server: KEYCHAIN_SERVER });
        applyTokens(null);
        return { pushRevoked };
      },
      getAccessToken,
      renewSilently,
      forMember: (memberId: string) => tokensPinnedTo(memberId, depsRef.current, renewSilently),
    }),
    [state, config, applyTokens, renewSilently, getAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
