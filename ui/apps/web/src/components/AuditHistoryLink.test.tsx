import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { AuditHistoryLink, auditLogHref } from './AuditHistoryLink';

afterEach(cleanup);

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'm-1', 'cognito:groups': groups },
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

/** The session's roles, so a test can tell "no link" from "session still loading". */
function RolesProbe() {
  return <output data-testid="roles">{useAuth().roles.join(' ')}</output>;
}

function renderLink(groups: string[]) {
  render(
    <AuthProvider userManager={makeManager(groups)}>
      <MemoryRouter>
        <AuditHistoryLink entityType="MEMBER" entityId="m-24" />
        <RolesProbe />
      </MemoryRouter>
    </AuthProvider>,
  );
}

test('builds the audit log lookup URL, encoding the ID', () => {
  expect(auditLogHref('MEMBER', 'm-24')).toBe('/audit-log?entityType=MEMBER&entityId=m-24');
  expect(auditLogHref('OCCUPANCY', 'OCC 1/2')).toBe(
    '/audit-log?entityType=OCCUPANCY&entityId=OCC+1%2F2',
  );
});

test.each([['CHIEF'], ['ADMIN']])('%s sees the Change history link', async (role) => {
  renderLink(['MEMBER', role]);
  const link = await screen.findByRole('link', { name: 'Change history' });
  expect(link.getAttribute('href')).toBe('/audit-log?entityType=MEMBER&entityId=m-24');
});

test.each([['OFFICER'], ['TRAINING'], ['APPARATUS'], ['MEMBER']])(
  '%s, who cannot open the audit log, gets no link',
  async (role) => {
    renderLink(['MEMBER', role]);
    await waitFor(() => expect(screen.getByTestId('roles').textContent).toContain(role));
    expect(screen.queryByRole('link', { name: 'Change history' })).toBeNull();
  },
);
