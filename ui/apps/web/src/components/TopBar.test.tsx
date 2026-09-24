import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { User, UserManager } from 'oidc-client-ts';
import { AuthProvider } from '../auth/AuthContext';
import { TopBar } from './TopBar';

afterEach(cleanup);

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'm1', 'cognito:groups': groups },
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

function renderTopBar() {
  return render(
    <AuthProvider userManager={makeManager(['CHIEF'])}>
      <TopBar onOpenNav={() => undefined} />
    </AuthProvider>,
  );
}

// Regression for MAJOR-2: TopBar used to render a hardcoded "Connected" string in this
// role="status" region regardless of reality — a false operational-status claim in a
// life-safety dispatch app. It's now derived from navigator.onLine and labelled for exactly
// what it measures (browser network reachability, not dispatch/API connectivity).
describe('TopBar connectivity status', () => {
  test('never renders the old fabricated "Connected" claim', async () => {
    renderTopBar();
    await screen.findByRole('status');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  test('reflects navigator.onLine === true as "online"', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('online');
  });

  test('reflects navigator.onLine === false as "offline"', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('offline');
  });

  test('updates live when the browser goes offline then back online', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    renderTopBar();
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('online');

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    expect(status.textContent).toContain('offline');

    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(status.textContent).toContain('online');
  });
});
