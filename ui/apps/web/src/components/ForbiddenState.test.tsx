import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import { RequireRole } from '../routing/RequireRole';
import { ForbiddenState } from './ForbiddenState';

afterEach(cleanup);

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'u1', 'cognito:groups': groups },
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

function renderGuardedAt(path: string, groups: string[]) {
  render(
    <AuthProvider userManager={makeManager(groups)}>
      <MemoryRouter initialEntries={[path]}>
        <RequireRole>
          <p>page</p>
        </RequireRole>
      </MemoryRouter>
    </AuthProvider>,
  );
}

// design.md §4.7: a no-permission state says what is restricted, to whom, and who grants it.
test('a route-guard denial names the roles that can open the page and offers the dashboard', async () => {
  renderGuardedAt('/settings/losap', ['CHIEF']);

  expect(await screen.findByRole('heading', { level: 1, name: 'Forbidden' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('You do not have access to this page.');
  expect(
    screen.getByText(/^Only the administrator can open the LOSAP settings page\. Ask the chief/),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
});

test('roles are listed highest authority first', async () => {
  renderGuardedAt('/settings/cad-sources', ['MEMBER']);
  expect(
    await screen.findByText(/^Only the chief and administrator can open the CAD sources page\./),
  ).toBeTruthy();
});

test('an API 403 on a page the user may open never claims who could open it', () => {
  render(
    <MemoryRouter initialEntries={['/apparatus']}>
      <ForbiddenState problem={{ title: 'Forbidden', detail: 'x', traceId: 'abc-123' }} />
    </MemoryRouter>,
  );
  expect(screen.queryByText(/^Only the /)).toBeNull();
  expect(screen.getByText(/Ask the chief or the department administrator/)).toBeTruthy();
  expect(screen.queryByText('abc-123')).toBeNull();
});
