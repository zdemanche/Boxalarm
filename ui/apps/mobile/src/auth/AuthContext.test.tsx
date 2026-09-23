import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Pressable, Text, type AppStateStatus } from 'react-native';
import type { AuthConfiguration, AuthorizeResult, RefreshResult } from 'react-native-app-auth';
import { AuthProvider, useAuth, type AuthDeps } from './AuthContext';
import { apiRequest, ApiError, type AuthTokenSource } from '../lib/apiClient';

function captureAppStateHandler(): (status: AppStateStatus) => void {
  let handler: ((status: AppStateStatus) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    listener: (status: AppStateStatus) => void,
  ) => {
    handler = listener;
    return { remove: jest.fn() };
  }) as typeof AppState.addEventListener);
  return (status: AppStateStatus) => handler?.(status);
}

jest.mock('react-native-config', () => ({
  __esModule: true,
  default: {
    COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    COGNITO_NATIVE_CLIENT_ID: 'native-client',
    API_BASE_URL: 'https://api.example.test',
  },
}));

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function issuedTokens(
  overrides: Partial<{ accessToken: string; refreshToken: string; idToken: string }> = {},
) {
  const idToken = `h.${base64url(JSON.stringify({ sub: 'MBR-1', 'cognito:groups': ['OFFICER'] }))}.s`;
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpirationDate: new Date(Date.now() + 3600_000).toISOString(),
    idToken,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  let stored: { username: string; password: string } | false = false;

  const deps = {
    authorize: jest.fn(async () => issuedTokens() as unknown as AuthorizeResult),
    refresh: jest.fn(
      async () =>
        ({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          accessTokenExpirationDate: new Date(Date.now() + 3600_000).toISOString(),
          idToken: issuedTokens().idToken,
          tokenType: 'Bearer',
        }) as RefreshResult,
    ),
    setInternetCredentials: jest.fn(async (_server: string, username: string, password: string) => {
      stored = { username, password };
      return { service: 'boxalarm-auth', storage: 'keychain' };
    }),
    getInternetCredentials: jest.fn(async () =>
      stored ? { ...stored, service: 'boxalarm-auth', storage: 'keychain' } : false,
    ),
    resetInternetCredentials: jest.fn(async () => {
      stored = false;
      return true;
    }),
  };

  return { ...deps, ...overrides } as unknown as AuthDeps;
}

function withStored(deps: AuthDeps, stored: unknown): void {
  deps.getInternetCredentials = jest.fn(async () => ({
    username: 'boxalarm-auth',
    password: JSON.stringify(stored),
    service: 'boxalarm-auth',
    storage: 'keychain',
  })) as unknown as AuthDeps['getInternetCredentials'];
}

function AuthProbe() {
  const { isAuthenticated, isLoading, roles } = useAuth();
  if (isLoading) return null;
  return <Text>{isAuthenticated ? `authenticated:${roles.join(',')}` : 'unauthenticated'}</Text>;
}

test('a cold start with no stored credentials renders unauthenticated without crashing', async () => {
  const deps = makeDeps();
  const { findByText } = await render(
    <AuthProvider deps={deps}>
      <AuthProbe />
    </AuthProvider>,
  );

  await findByText('unauthenticated');
});

test('a Keychain read that rejects on startup renders the sign-in screen rather than hanging in loading', async () => {
  const deps = makeDeps();
  deps.getInternetCredentials = jest.fn(async () => {
    throw new Error('Keychain access denied');
  }) as unknown as AuthDeps['getInternetCredentials'];

  const { findByText } = await render(
    <AuthProvider deps={deps}>
      <AuthProbe />
    </AuthProvider>,
  );

  await findByText('unauthenticated');
});

test('signIn stores tokens via Keychain with no client secret in the authorize config', async () => {
  const deps = makeDeps();
  let capturedConfig: AuthConfiguration | undefined;
  deps.authorize = jest.fn(async (config: AuthConfiguration) => {
    capturedConfig = config;
    return issuedTokens() as unknown as AuthorizeResult;
  });

  function SignInProbe() {
    const { signIn, isAuthenticated } = useAuth();
    return (
      <>
        <Pressable onPress={() => void signIn()} accessibilityLabel="sign-in-trigger" />
        <Text>{isAuthenticated ? 'authenticated:OFFICER' : 'unauthenticated'}</Text>
      </>
    );
  }

  const { findByText, getByLabelText } = await render(
    <AuthProvider deps={deps}>
      <SignInProbe />
    </AuthProvider>,
  );

  await findByText('unauthenticated');
  fireEvent.press(getByLabelText('sign-in-trigger'));

  await findByText('authenticated:OFFICER');
  expect(deps.setInternetCredentials).toHaveBeenCalledTimes(1);
  expect(capturedConfig && 'clientSecret' in capturedConfig).toBe(false);
});

test('a rejected authorize() (cancel/network) leaves the session signed out with no partial token stored', async () => {
  const deps = makeDeps();
  deps.authorize = jest.fn(async () => {
    throw new Error('user cancelled');
  });

  function SignInProbe() {
    const { signIn } = useAuth();
    return (
      <Pressable
        onPress={() => {
          signIn().catch(() => undefined);
        }}
        accessibilityLabel="sign-in-trigger"
      />
    );
  }

  const { findByText, getByLabelText, getByText } = await render(
    <AuthProvider deps={deps}>
      <SignInProbe />
      <AuthProbe />
    </AuthProvider>,
  );

  await findByText('unauthenticated');
  fireEvent.press(getByLabelText('sign-in-trigger'));

  await waitFor(() => expect(deps.authorize).toHaveBeenCalledTimes(1));
  expect(deps.setInternetCredentials).not.toHaveBeenCalled();
  expect(getByText('unauthenticated')).toBeTruthy();
});

test('getAccessToken silently refreshes an expired stored token via react-native-app-auth refresh()', async () => {
  const stored = issuedTokens({ accessToken: 'expired-access' });
  stored.accessTokenExpirationDate = new Date(Date.now() - 1000).toISOString();
  const deps = makeDeps();
  withStored(deps, stored);

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(contextValue?.isLoading).toBe(false));
  const token = await contextValue?.getAccessToken();

  expect(token).toBe('access-2');
  expect(deps.refresh).toHaveBeenCalled();
});

test('a stored token with an unparseable (missing) expiry is treated as expired, not as valid forever', async () => {
  const full = issuedTokens();
  const malformed = {
    accessToken: full.accessToken,
    refreshToken: full.refreshToken,
    idToken: full.idToken,
  };
  const deps = makeDeps();
  withStored(deps, malformed);

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(contextValue?.isLoading).toBe(false));
  const token = await contextValue?.getAccessToken();

  expect(deps.refresh).toHaveBeenCalled();
  expect(token).toBe('access-2');
});

test('a refresh failing for a non-definitive reason (network) retains the previously authenticated session', async () => {
  const stored = issuedTokens();
  stored.accessTokenExpirationDate = new Date(Date.now() - 1000).toISOString();
  const deps = makeDeps();
  withStored(deps, stored);
  deps.refresh = jest.fn(async () => {
    throw new Error('network unreachable');
  }) as unknown as AuthDeps['refresh'];

  const { findByText } = await render(
    <AuthProvider deps={deps}>
      <AuthProbe />
    </AuthProvider>,
  );

  await findByText('authenticated:OFFICER');
  expect(deps.resetInternetCredentials).not.toHaveBeenCalled();
});

test('a refresh failing with a definitive invalid_grant clears the Keychain and signs out', async () => {
  const stored = issuedTokens();
  stored.accessTokenExpirationDate = new Date(Date.now() - 1000).toISOString();
  const deps = makeDeps();
  withStored(deps, stored);
  deps.refresh = jest.fn(async () => {
    throw Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' });
  }) as unknown as AuthDeps['refresh'];

  const { findByText } = await render(
    <AuthProvider deps={deps}>
      <AuthProbe />
    </AuthProvider>,
  );

  await findByText('unauthenticated');
  expect(deps.resetInternetCredentials).toHaveBeenCalledTimes(1);
});

test('concurrent refresh callers share a single in-flight request (single-flight)', async () => {
  const stored = issuedTokens();
  stored.accessTokenExpirationDate = new Date(Date.now() - 1000).toISOString();
  let resolveRefresh: (value: RefreshResult) => void = () => undefined;
  const refreshPromise = new Promise<RefreshResult>((resolve) => {
    resolveRefresh = resolve;
  });
  const deps = makeDeps({
    refresh: jest.fn(() => refreshPromise) as unknown as AuthDeps['refresh'],
  });
  withStored(deps, stored);

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(deps.refresh).toHaveBeenCalledTimes(1));

  const second = contextValue!.renewSilently();
  const third = contextValue!.getAccessToken();

  resolveRefresh({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    accessTokenExpirationDate: new Date(Date.now() + 3600_000).toISOString(),
    idToken: issuedTokens().idToken,
    tokenType: 'Bearer',
  });

  await expect(second).resolves.toBe('access-2');
  await expect(third).resolves.toBe('access-2');
  expect(deps.refresh).toHaveBeenCalledTimes(1);
});

test('apiRequest (mobile) retries once via renewSilently on a 401 then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = jest.fn(async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const tokens: AuthTokenSource = {
    getAccessToken: jest.fn(async () => 'stale'),
    renewSilently: jest.fn(async () => 'fresh'),
  };

  const response = await apiRequest('personnel/members', tokens, {
    apiBaseUrl: 'https://api.example.test',
  });

  expect(response.status).toBe(200);
  expect(tokens.renewSilently).toHaveBeenCalledTimes(1);
});

test('apiRequest (mobile) aborts rather than replaying unauthenticated when renewal yields no token', async () => {
  let calls = 0;
  globalThis.fetch = jest.fn(async () => {
    calls += 1;
    return new Response(null, { status: 401 });
  }) as unknown as typeof fetch;

  const tokens: AuthTokenSource = {
    getAccessToken: jest.fn(async () => 'stale'),
    renewSilently: jest.fn(async () => null),
  };

  await expect(
    apiRequest('personnel/members', tokens, { apiBaseUrl: 'https://api.example.test' }),
  ).rejects.toBeInstanceOf(ApiError);
  expect(calls).toBe(1);
});

test('signOut sends the push-token DELETE before clearing stored credentials', async () => {
  const stored = issuedTokens();
  const deps = makeDeps();
  withStored(deps, stored);
  const calls: string[] = [];
  globalThis.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET');
    return new Response(JSON.stringify({ revoked: true }), { status: 200 });
  }) as unknown as typeof fetch;

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );
  await waitFor(() => expect(contextValue?.isLoading).toBe(false));

  await contextValue!.signOut();

  expect(calls).toEqual(['DELETE']);
  expect(deps.resetInternetCredentials).toHaveBeenCalledTimes(1);
});

test('signOut clears credentials even when the push-token DELETE fails', async () => {
  const stored = issuedTokens();
  const deps = makeDeps();
  withStored(deps, stored);
  globalThis.fetch = jest.fn(async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );
  await waitFor(() => expect(contextValue?.isLoading).toBe(false));

  await contextValue!.signOut();

  expect(deps.resetInternetCredentials).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('foregrounding with a near-expiry stored token refreshes once, single-flighted', async () => {
  const stored = issuedTokens();
  stored.accessTokenExpirationDate = new Date(Date.now() + 60_000).toISOString();
  const deps = makeDeps();
  withStored(deps, stored);
  const fireAppStateChange = captureAppStateHandler();

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  await render(
    <AuthProvider deps={deps}>
      <Capture />
    </AuthProvider>,
  );
  await waitFor(() => expect(contextValue?.isLoading).toBe(false));

  fireAppStateChange('active');
  const joined = contextValue!.renewSilently();

  await expect(joined).resolves.toBe('access-2');
  expect(deps.refresh).toHaveBeenCalledTimes(1);
});

test('a Keychain read that rejects on foreground keeps the session authenticated', async () => {
  const stored = issuedTokens();
  const deps = makeDeps();
  withStored(deps, stored);
  const fireAppStateChange = captureAppStateHandler();

  const { findByText, queryByText } = await render(
    <AuthProvider deps={deps}>
      <AuthProbe />
    </AuthProvider>,
  );
  await findByText('authenticated:OFFICER');

  deps.getInternetCredentials = jest.fn(async () => {
    throw new Error('Keychain access denied');
  }) as unknown as AuthDeps['getInternetCredentials'];
  fireAppStateChange('active');

  await waitFor(() => expect(deps.getInternetCredentials).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(queryByText('unauthenticated')).toBeNull();
  expect(await findByText('authenticated:OFFICER')).toBeTruthy();
});
