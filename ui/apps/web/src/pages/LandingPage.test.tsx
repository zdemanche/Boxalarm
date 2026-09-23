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
