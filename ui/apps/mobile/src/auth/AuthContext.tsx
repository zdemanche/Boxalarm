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
import { revokePushToken } from '../features/alerts/pushTokens';
import { buildOidcConfig } from './config';
import { kvDelete, kvSet } from '../sync/kvStore';
import { clearMemberCache, LAST_SESSION_SUB_KEY } from '../sync/memberCache';

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

function isInvalidGrant(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'invalid_grant'
  );
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

export function createStoredTokenSource(deps: AuthDeps = defaultDeps) {
  let renewing: Promise<string | null> | null = null;
  const renewSilently = (): Promise<string | null> => {
    renewing ??= (async () => {
      try {
        const stored = await readStoredTokens(deps);
        if (!stored) return null;
        const result = await deps.refresh(buildOidcConfig(), { refreshToken: stored.refreshToken });
        const next: StoredTokens = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken ?? stored.refreshToken,
          accessTokenExpirationDate: result.accessTokenExpirationDate,
          idToken: result.idToken,
        };
        await writeStoredTokens(deps, next);
        return next.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
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

export interface AuthContextValue extends AuthState {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
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

    const attempt = (async () => {
      try {
        const stored = await readStoredTokens(depsRef.current);
        if (!stored) {
          applyTokens(null);
          return null;
        }
        const result = await depsRef.current.refresh(config, {
          refreshToken: stored.refreshToken,
        });
        const next: StoredTokens = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken ?? stored.refreshToken,
          accessTokenExpirationDate: result.accessTokenExpirationDate,
          idToken: result.idToken,
        };
        await writeStoredTokens(depsRef.current, next);
        applyTokens(next);
        return next.accessToken;
      } catch (error) {
        if (isInvalidGrant(error)) {
          await depsRef.current.resetInternetCredentials({ server: KEYCHAIN_SERVER });
          applyTokens(null);
        }
        return null;
      }
    })();

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

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
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
    };
  }, [applyTokens, renewSilently]);

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
        await writeStoredTokens(depsRef.current, tokens);
        applyTokens(tokens);
      },
      signOut: async () => {
        // E1-S14-UI AC5: the DELETE must be sent before local credentials are cleared, so a
        // signed-out device stops receiving pages. Best-effort: sign-out must never be blocked
        // by a network failure.
        const stored = await readStoredTokens(depsRef.current).catch(() => null);
        const apiBaseUrl = Config.API_BASE_URL;
        const memberId = stored ? decodeMemberId(stored.idToken) : null;
        if (stored && memberId && apiBaseUrl) {
          await revokePushToken(
            memberId,
            { getAccessToken: async () => stored.accessToken, renewSilently: async () => null },
            apiBaseUrl,
          ).catch(() => undefined);
        }
        // The member's cached apparatus, shifts, check drafts and last mark-off stay on the phone
        // otherwise (review m8). Queued writes in the outbox are kept: they are the member's
        // work and sync once someone signs in.
        if (memberId) await clearMemberCache(memberId).catch(() => undefined);
        // Before the keychain reset, so no window exists where the hint outlives the session.
        await kvDelete(LAST_SESSION_SUB_KEY);
        await depsRef.current.resetInternetCredentials({ server: KEYCHAIN_SERVER });
        applyTokens(null);
      },
      getAccessToken: async () => {
        const stored = await readStoredTokens(depsRef.current);
        if (!stored) return null;
        return isExpired(stored) ? renewSilently() : stored.accessToken;
      },
      renewSilently,
    }),
    [state, config, applyTokens, renewSilently],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
