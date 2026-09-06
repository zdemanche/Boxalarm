import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { SignInPage } from './SignInPage';

afterEach(cleanup);

function makeManager(): UserManager {
  return {
    getUser: vi.fn(async () => null),
    signinRedirect: vi.fn(async () => undefined),
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

test('the sign-in button has a unique accessible name and no MFA prompt', async () => {
  render(
    <AuthProvider userManager={makeManager()}>
      <SignInPage />
    </AuthProvider>,
  );

  expect(await screen.findAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
  expect(screen.queryByText(/mfa/i)).toBeNull();
});

test('clicking sign in starts the OIDC redirect', async () => {
  const manager = makeManager();
  render(
    <AuthProvider userManager={manager}>
      <SignInPage />
    </AuthProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

  expect(manager.signinRedirect).toHaveBeenCalledTimes(1);
});
