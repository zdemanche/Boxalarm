import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ErrorResponse, type User, type UserManager } from 'oidc-client-ts';
import { AuthProvider, useAuth } from './AuthContext';
import { apiRequest, ApiError, type AuthTokenSource } from '../lib/apiClient';
import { AuthCallbackPage } from '../pages/AuthCallbackPage';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

type Listener = (user: User | null) => void;
type ErrorListener = (error: Error) => void;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'member-1', 'cognito:groups': ['CHIEF'] },
    ...overrides,
  } as User;
}

function makeFakeUserManager(
  initialUser: User | null,
  options: { signinSilent?: () => Promise<User | null> } = {},
) {
  const loaded: Listener[] = [];
  const unloaded: Listener[] = [];
  const renewError: ErrorListener[] = [];
  const current = initialUser;

  const manager = {
    getUser: vi.fn(async () => current),
    signinRedirect: vi.fn(async () => undefined),
    signoutRedirect: vi.fn(async () => undefined),
    signinCallback: vi.fn(async () => (current as User) ?? undefined),
    signinSilent: vi.fn(options.signinSilent ?? (async () => current)),
    removeUser: vi.fn(async () => {
      unloaded.forEach((cb) => cb(null));
    }),
    events: {
      addUserLoaded: (cb: Listener) => loaded.push(cb),
      removeUserLoaded: (cb: Listener) => {
        const i = loaded.indexOf(cb);
        if (i >= 0) loaded.splice(i, 1);
      },
      addUserUnloaded: (cb: Listener) => unloaded.push(cb),
      removeUserUnloaded: (cb: Listener) => {
        const i = unloaded.indexOf(cb);
        if (i >= 0) unloaded.splice(i, 1);
      },
      addSilentRenewError: (cb: ErrorListener) => renewError.push(cb),
      removeSilentRenewError: () => undefined,
    },
  } as unknown as UserManager;

  return {
    manager,
    emitRenewError(error: Error = new Error('network unreachable')) {
      renewError.forEach((cb) => cb(error));
    },
  };
}

function AuthProbe() {
  const { isAuthenticated, isLoading, roles } = useAuth();
  if (isLoading) return <p>loading</p>;
  return (
    <p>
      {isAuthenticated ? 'authenticated' : 'unauthenticated'}:{roles.join(',')}
    </p>
  );
}

test('a session with a valid token renders authenticated with no MFA challenge surfaced', async () => {
  const { manager } = makeFakeUserManager(makeUser());
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  expect(screen.queryByText(/mfa/i)).toBeNull();
});

test('an idle session with a still-valid token remains authenticated with no interaction', async () => {
  const { manager } = makeFakeUserManager(makeUser());
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.getByText('authenticated:CHIEF')).toBeTruthy();
  expect(manager.signinRedirect).not.toHaveBeenCalled();
});

test('an absent roles claim falls back to the base member role without crashing', async () => {
  const { manager } = makeFakeUserManager(
    makeUser({ profile: { sub: 'm1' } as unknown as User['profile'] }),
  );
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:MEMBER');
});

test('a wrong-typed roles claim falls back to the base member role without crashing', async () => {
  const { manager } = makeFakeUserManager(
    makeUser({ profile: { sub: 'm1', roles: 'CHIEF' } as unknown as User['profile'] }),
  );
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:MEMBER');
});

test('a silent-renew failure (issuer unreachable) retains the authenticated session rather than forcing sign-out', async () => {
  const { manager, emitRenewError } = makeFakeUserManager(makeUser());
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  emitRenewError(new Error('network unreachable'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.getByText('authenticated:CHIEF')).toBeTruthy();
});

test('a session with an expired access token still renders authenticated and triggers a silent renewal', async () => {
  const { manager } = makeFakeUserManager(makeUser({ expired: true }));
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  await waitFor(() => expect(manager.signinSilent).toHaveBeenCalled());
});

test('concurrent renewSilently callers share a single in-flight request (single-flight)', async () => {
  let resolveSignin: (user: User) => void = () => undefined;
  const pending = new Promise<User>((resolve) => {
    resolveSignin = resolve;
  });
  const { manager } = makeFakeUserManager(makeUser(), {
    signinSilent: () => pending,
  });

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  render(
    <AuthProvider userManager={manager}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(contextValue?.isLoading).toBe(false));

  const first = contextValue!.renewSilently();
  const second = contextValue!.renewSilently();

  resolveSignin(makeUser({ access_token: 'renewed-token' }));

  await expect(first).resolves.toBe('renewed-token');
  await expect(second).resolves.toBe('renewed-token');
  expect(manager.signinSilent).toHaveBeenCalledTimes(1);
});

test('a silent-renew failure with a definitive invalid_grant signs the session out', async () => {
  const { manager, emitRenewError } = makeFakeUserManager(makeUser());
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('authenticated:CHIEF');
  emitRenewError(new ErrorResponse({ error: 'invalid_grant' }));

  await screen.findByText('unauthenticated:');
});

test('a direct signinSilent rejection with invalid_grant ends the session, not only the addSilentRenewError event path', async () => {
  const { manager } = makeFakeUserManager(makeUser({ expired: true }), {
    signinSilent: () => Promise.reject(new ErrorResponse({ error: 'invalid_grant' })),
  });
  render(
    <AuthProvider userManager={manager}>
      <AuthProbe />
    </AuthProvider>,
  );

  await screen.findByText('unauthenticated:');
  expect(manager.removeUser).toHaveBeenCalledTimes(1);
});

test('startup renewal and a concurrent caller share the same single-flighted signinSilent call', async () => {
  let resolveSignin: (user: User) => void = () => undefined;
  const pending = new Promise<User>((resolve) => {
    resolveSignin = resolve;
  });
  const { manager } = makeFakeUserManager(makeUser({ expired: true }), {
    signinSilent: () => pending,
  });

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  render(
    <AuthProvider userManager={manager}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(manager.signinSilent).toHaveBeenCalledTimes(1));

  const manualCall = contextValue!.renewSilently();
  resolveSignin(makeUser({ access_token: 'renewed-token' }));

  await expect(manualCall).resolves.toBe('renewed-token');
  expect(manager.signinSilent).toHaveBeenCalledTimes(1);
});

test('getAccessToken renews an expired token inline rather than returning null', async () => {
  const { manager } = makeFakeUserManager(makeUser({ expired: true }), {
    signinSilent: async () => makeUser({ access_token: 'renewed-token', expired: false }),
  });

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  render(
    <AuthProvider userManager={manager}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(contextValue?.isLoading).toBe(false));
  const token = await contextValue!.getAccessToken();

  expect(token).toBe('renewed-token');
});

test('a transient signinSilent failure is retried with backoff more than twice, not abandoned', async () => {
  const { manager } = makeFakeUserManager(makeUser(), {
    signinSilent: () => Promise.reject(new Error('network unreachable')),
  });

  let contextValue: ReturnType<typeof useAuth> | undefined;
  function Capture() {
    contextValue = useAuth();
    return null;
  }

  render(
    <AuthProvider userManager={manager}>
      <Capture />
    </AuthProvider>,
  );

  await waitFor(() => expect(contextValue?.isLoading).toBe(false));

  vi.useFakeTimers();
  try {
    void contextValue!.renewSilently();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(manager.signinSilent).mock.calls.length).toBeGreaterThan(2);
  } finally {
    vi.useRealTimers();
  }
});

test('an OIDC callback carrying an MFA-challenge-shaped param is ignored — no MFA code path exists', async () => {
  window.history.pushState({}, '', '/auth/callback?mfa_challenge=totp_one_time_code');
  const { manager } = makeFakeUserManager(makeUser());

  render(
    <MemoryRouter initialEntries={['/auth/callback?mfa_challenge=totp_one_time_code']}>
      <AuthProvider userManager={manager}>
        <AuthCallbackPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  await waitFor(() => expect(manager.signinCallback).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(manager.signinCallback).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/mfa/i)).toBeNull();
});

test('apiRequest retries once via silent renewal on a 401 then succeeds', async () => {
  let calls = 0;
  server.use(
    http.get('/api/v1/personnel/members', () => {
      calls += 1;
      return calls === 1
        ? new HttpResponse(null, { status: 401 })
        : HttpResponse.json({ members: [] });
    }),
  );

  const tokens: AuthTokenSource = {
    getAccessToken: vi.fn(async () => 'expired'),
    renewSilently: vi.fn(async () => 'fresh'),
  };
  const response = await apiRequest('personnel/members', tokens);

  expect(response.status).toBe(200);
  expect(tokens.renewSilently).toHaveBeenCalledTimes(1);
});

test('apiRequest surfaces a 403 as an ApiError with traceId, without prompting re-authentication', async () => {
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, traceId: 'trace-1' },
        { status: 403 },
      ),
    ),
  );

  const tokens: AuthTokenSource = {
    getAccessToken: vi.fn(async () => 'token'),
    renewSilently: vi.fn(async () => null),
  };

  await expect(apiRequest('personnel/members', tokens)).rejects.toBeInstanceOf(ApiError);
  expect(tokens.renewSilently).not.toHaveBeenCalled();
});

test('apiRequest aborts rather than replaying unauthenticated when silent renewal yields no token', async () => {
  let calls = 0;
  server.use(
    http.get('/api/v1/personnel/members', ({ request }) => {
      calls += 1;
      if (request.headers.get('authorization')) return new HttpResponse(null, { status: 401 });
      return calls === 1
        ? new HttpResponse(null, { status: 401 })
        : HttpResponse.json({ members: [] });
    }),
  );

  const tokens: AuthTokenSource = {
    getAccessToken: vi.fn(async () => 'expired'),
    renewSilently: vi.fn(async () => null),
  };

  await expect(apiRequest('personnel/members', tokens)).rejects.toBeInstanceOf(ApiError);
  expect(calls).toBe(1);
});
