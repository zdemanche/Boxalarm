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
import { ErrorResponse, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { buildOidcConfig } from './config';
import { rolesFromProfile, type Role } from './roles';

export type { Role } from './roles';

const RENEW_RETRY_MAX_DELAY_MS = 30_000;
const RENEW_RETRY_BASE_DELAY_MS = 1_000;

function isInvalidGrant(error: Error): boolean {
  return error instanceof ErrorResponse && error.error === 'invalid_grant';
}

function scheduleRetry(
  retryCountRef: { current: number },
  retryTimerRef: { current: ReturnType<typeof setTimeout> | undefined },
  renew: () => void,
): void {
  const delay = Math.min(
    RENEW_RETRY_MAX_DELAY_MS,
    RENEW_RETRY_BASE_DELAY_MS * 2 ** retryCountRef.current,
  );
  retryCountRef.current += 1;
  retryTimerRef.current = setTimeout(renew, delay);
}

interface AuthState {
  user: User | null;
  roles: Role[];
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface AuthContextValue extends AuthState {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  completeSignIn: () => Promise<User | undefined>;
  getAccessToken: () => Promise<string | null>;
  renewSilently: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function createUserManager(): UserManager {
  return new UserManager({
    ...buildOidcConfig(),
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  });
}

export function AuthProvider({
  children,
  userManager,
}: {
  children: ReactNode;
  userManager?: UserManager;
}) {
  const manager = useMemo(() => userManager ?? createUserManager(), [userManager]);
  const [state, setState] = useState<AuthState>({
    user: null,
    roles: [],
    isAuthenticated: false,
    isLoading: true,
  });
  const renewInFlightRef = useRef<Promise<string | null> | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const renewSilently = useCallback((): Promise<string | null> => {
    if (renewInFlightRef.current) return renewInFlightRef.current;

    const attempt = manager
      .signinSilent()
      .then((user) => (user && !user.expired ? user.access_token : null))
      .catch(async (error: Error) => {
        if (isInvalidGrant(error)) {
          await manager.removeUser();
          return null;
        }
        scheduleRetry(retryCountRef, retryTimerRef, () => void renewSilently());
        return null;
      });

    renewInFlightRef.current = attempt.finally(() => {
      renewInFlightRef.current = null;
    });
    return renewInFlightRef.current;
  }, [manager]);

  const completeSignIn = useCallback(() => manager.signinCallback(), [manager]);

  useEffect(() => {
    let cancelled = false;

    const apply = (user: User | null) => {
      if (cancelled) return;
      retryCountRef.current = 0;
      setState({
        user,
        roles: user ? rolesFromProfile(user.profile as Record<string, unknown>) : [],
        isAuthenticated: user !== null,
        isLoading: false,
      });
    };

    const onUnloaded = () => apply(null);
    const onSilentRenewError = (error: Error) => {
      if (isInvalidGrant(error)) {
        apply(null);
        return;
      }
      scheduleRetry(retryCountRef, retryTimerRef, () => void renewSilently());
    };

    manager
      .getUser()
      .then((user) => {
        apply(user);
        if (user && user.expired) void renewSilently();
      })
      .catch(() => apply(null));
    manager.events.addUserLoaded(apply);
    manager.events.addUserUnloaded(onUnloaded);
    manager.events.addSilentRenewError(onSilentRenewError);

    return () => {
      cancelled = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      manager.events.removeUserLoaded(apply);
      manager.events.removeUserUnloaded(onUnloaded);
      manager.events.removeSilentRenewError(onSilentRenewError);
    };
  }, [manager, renewSilently]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn: () => manager.signinRedirect(),
      signOut: () => manager.signoutRedirect(),
      completeSignIn,
      getAccessToken: async () => {
        const user = await manager.getUser();
        if (!user) return null;
        return user.expired ? await renewSilently() : user.access_token;
      },
      renewSilently,
    }),
    [state, manager, completeSignIn, renewSilently],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
