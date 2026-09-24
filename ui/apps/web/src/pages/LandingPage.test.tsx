import { typography } from '@boxalarm/design-tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { LandingPage } from './LandingPage';

const server = setupServer(
  http.get('/api/v1/apparatus', () => HttpResponse.json({ items: [] })),
  http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(profile: Record<string, unknown>): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile,
  } as unknown as User;
  return {
    getUser: vi.fn(async () => user),
    events: {
      addUserLoaded: () => undefined,
      removeUserLoaded: () => undefined,
      addUserUnloaded: () => undefined,
      removeUserUnloaded: () => undefined,
      addSilentRenewError: () => undefined,
      removeSilentRenewError: () => undefined,
    },
  } as unknown as UserManager;
}

function renderLanding(profile: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(profile)}>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('renders the highest-priority role dashboard when CHIEF is present', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['MEMBER', 'CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
});

test('falls back to member home when no groups are present', async () => {
  renderLanding({ sub: 'm1' });
  await screen.findByRole('heading', { name: 'Member home' });
});

test('the heading uses the design-token type scale, matching the sign-in page', async () => {
  renderLanding({ sub: 'm1' });
  const heading = await screen.findByRole('heading', { name: 'Member home' });
  expect(heading.style.fontSize).toBe(`${typography.size.xl}px`);
});

// Regression for MAJOR-2: the dashboard used to hardcode "No active call." as fact in a
// role="status" live region regardless of whether a call was actually active. There is no
// incidents/dispatch feature in this app yet, so the honest state is an explicit
// "not wired" placeholder, not a fabricated claim.
test('CHIEF dashboard never claims "No active call" — shows an honest not-wired placeholder instead', async () => {
  renderLanding({ sub: 'm1', 'cognito:groups': ['CHIEF'] });
  await screen.findByRole('heading', { name: 'Chief dashboard' });
  expect(screen.queryByText(/no active call/i)).toBeNull();
  expect(screen.getByText(/active-call status isn.t wired to this dashboard yet/i)).toBeTruthy();
});
