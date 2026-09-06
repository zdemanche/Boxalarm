import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { LandingPage } from './LandingPage';

afterEach(cleanup);

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

test('renders the highest-priority role dashboard when multiple roles are present', async () => {
  render(
    <AuthProvider userManager={makeManager({ sub: 'm1', roles: ['MEMBER', 'ADMIN'] })}>
      <LandingPage />
    </AuthProvider>,
  );

  await screen.findByRole('heading', { name: 'Admin dashboard' });
});

test('falls back to the member dashboard when no roles are present', async () => {
  render(
    <AuthProvider userManager={makeManager({ sub: 'm1' })}>
      <LandingPage />
    </AuthProvider>,
  );

  await screen.findByRole('heading', { name: 'Member dashboard' });
});
