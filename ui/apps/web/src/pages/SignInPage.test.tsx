import { radius, typography } from '@boxalarm/design-tokens';
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

test('the sign-in button uses the accent token color and radius, matching the mobile design system', async () => {
  render(
    <AuthProvider userManager={makeManager()}>
      <SignInPage />
    </AuthProvider>,
  );

  const button = await screen.findByRole('button', { name: 'Sign in' });
  expect(button.style.background).toBe('var(--boxalarm-accent)');
  expect(button.style.color).toBe('var(--boxalarm-bg)');
  expect(button.style.borderRadius).toBe(`${radius.default}px`);
});

test('the heading uses the design-token display type scale', async () => {
  render(
    <AuthProvider userManager={makeManager()}>
      <SignInPage />
    </AuthProvider>,
  );

  const heading = await screen.findByRole('heading', { name: 'Boxalarm' });
  expect(heading.style.fontSize).toBe(`${typography.size.display}px`);
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
