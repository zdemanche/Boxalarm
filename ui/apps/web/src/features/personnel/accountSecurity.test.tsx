import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { AccountSecuritySection, canUseAccountKillSwitches } from './AccountSecuritySection';
import type { Member } from './types';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

const MEMBER: Member = {
  memberId: 'm1',
  deptId: 'NICHOLS',
  firstName: 'Sam',
  lastName: 'Lee',
  email: 'sam@example.com',
  phone: '203-555-0199',
  status: 'ACTIVE',
  joinDate: '2020-01-01',
  rank: 'Lt',
  agencyId: 'NFD-1',
} as Member;

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'admin-1', 'cognito:groups': groups },
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

function renderSection(groups: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <AccountSecuritySection member={MEMBER} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('only CHIEF and ADMIN see the kill switches, matching the Cedar policy', async () => {
  expect(canUseAccountKillSwitches(['CHIEF'])).toBe(true);
  expect(canUseAccountKillSwitches(['ADMIN'])).toBe(true);
  expect(canUseAccountKillSwitches(['OFFICER', 'TRAINING'])).toBe(false);

  renderSection(['MEMBER', 'OFFICER']);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { name: 'Account security' })).toBeNull();
  });
  expect(screen.queryByRole('button', { name: 'Reset password and sign out' })).toBeNull();
});

test('reset password: confirm names the member and the consequence, then posts once', async () => {
  const posts: unknown[] = [];
  server.use(
    http.post('/api/v1/platform/sessions/reset-credentials', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(
        { memberId: 'm1', status: 'password-reset-and-signed-out' },
        { status: 202 },
      );
    }),
  );
  const user = userEvent.setup();
  renderSection(['CHIEF']);

  await user.click(await screen.findByRole('button', { name: 'Reset password and sign out' }));
  const dialog = await screen.findByRole('dialog', {
    name: "Reset Sam Lee's password and sign them out?",
  });
  expect(within(dialog).getByText(/current password will stop working/)).toBeTruthy();
  // No password or second-factor prompt: the role check is the whole gate (settled).
  expect(within(dialog).queryByLabelText(/password/i)).toBeNull();
  expect(posts).toEqual([]);

  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  await waitFor(() => {
    expect(screen.getByRole('status').textContent).toContain("Sam Lee's password no longer works");
  });
  expect(posts).toEqual([{ memberId: 'm1' }]);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('cancelling the confirmation sends nothing', async () => {
  const handler = vi.fn(() => HttpResponse.json({}, { status: 202 }));
  server.use(http.post('/api/v1/platform/sessions/reset-credentials', handler));
  const user = userEvent.setup();
  renderSection(['ADMIN']);

  await user.click(await screen.findByRole('button', { name: 'Reset password and sign out' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(handler).not.toHaveBeenCalled();
});

test('a partial reset (409) keeps the dialog open with the server explanation', async () => {
  server.use(
    http.post('/api/v1/platform/sessions/reset-credentials', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Every session was signed out, but the password could not be reset.',
          traceId: 't1',
        },
        { status: 409 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderSection(['CHIEF']);

  await user.click(await screen.findByRole('button', { name: 'Reset password and sign out' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  await waitFor(() => {
    expect(
      within(dialog).getByText(
        'Every session was signed out, but the password could not be reset.',
      ),
    ).toBeTruthy();
  });
});

const DEVICES = [
  {
    deviceId: 'install-tablet-41be02',
    platform: 'FCM',
    registeredAt: 1_790_000_000_000,
    valid: true,
  },
  {
    deviceId: 'install-phone-7f3a9c',
    platform: 'APNS',
    registeredAt: 1_789_000_000_000,
    valid: true,
  },
  { deviceId: null, platform: 'APNS', registeredAt: null, valid: true },
];

function serveDevicesAndRevoke(posts: unknown[]) {
  server.use(
    http.get('/api/v1/platform/sessions/m1/devices', () =>
      HttpResponse.json({ memberId: 'm1', devices: DEVICES }),
    ),
    http.post('/api/v1/platform/sessions/revoke', async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(
        { memberId: 'm1', status: 'revoked', push: 'invalidated' },
        { status: 202 },
      );
    }),
  );
}

test('report device lost defaults to all devices and says every device must sign in again', async () => {
  const posts: unknown[] = [];
  serveDevicesAndRevoke(posts);
  const user = userEvent.setup();
  renderSection(['ADMIN']);

  await user.click(await screen.findByRole('button', { name: 'Report device lost' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Report a lost device for Sam Lee?',
  });
  const group = within(dialog).getByRole('group', { name: 'Which device was lost?' });
  expect(within(group).getByRole('radio', { name: 'All devices' })).toHaveProperty('checked', true);
  // Platform, last registration and the installation-id suffix; never the whole id or a token.
  const phone = await within(group).findByRole('radio', { name: /iPhone .* id …7f3a9c/ });
  expect(phone).toHaveProperty('checked', false);
  expect(within(group).getByRole('radio', { name: /Android .* id …41be02/ })).toBeTruthy();
  expect(within(group).getByText(/older registration has no device id/)).toBeTruthy();
  expect(within(dialog).getByText(/must sign in again on each one/)).toBeTruthy();
  expect(within(dialog).getByText(/SMS and voice paging continue/)).toBeTruthy();

  await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

  await waitFor(() => {
    expect(screen.getByRole('status').textContent).toContain('signed out everywhere');
  });
  expect(posts).toEqual([{ memberId: 'm1' }]);
});

test('report device lost removes only the device the admin picks', async () => {
  const posts: unknown[] = [];
  serveDevicesAndRevoke(posts);
  const user = userEvent.setup();
  renderSection(['CHIEF']);

  await user.click(await screen.findByRole('button', { name: 'Report device lost' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(await within(dialog).findByRole('radio', { name: /iPhone .* id …7f3a9c/ }));
  expect(
    within(dialog).getByText(/Only the lost device stops receiving dispatch notifications/),
  ).toBeTruthy();
  expect(within(dialog).getByText(/must sign in again on each one/)).toBeTruthy();

  await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

  await waitFor(() => {
    expect(screen.getByRole('status').textContent).toContain('no longer receives dispatch');
  });
  expect(posts).toEqual([{ memberId: 'm1', deviceId: 'install-phone-7f3a9c' }]);
});

test('report device lost still offers all devices when the list cannot load', async () => {
  const posts: unknown[] = [];
  serveDevicesAndRevoke(posts);
  server.use(
    http.get('/api/v1/platform/sessions/m1/devices', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderSection(['CHIEF']);

  await user.click(await screen.findByRole('button', { name: 'Report device lost' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText(/Could not load this member’s devices/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

  await waitFor(() => {
    expect(posts).toEqual([{ memberId: 'm1' }]);
  });
});

test('a 403 shows a plain refusal, never the policy detail', async () => {
  const secret = 'Cedar: principal lacks Boxalarm::Action::"ResetMemberCredentials"';
  server.use(
    http.post('/api/v1/platform/sessions/reset-credentials', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, detail: secret, traceId: 't' },
        { status: 403 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderSection(['ADMIN']);

  await user.click(await screen.findByRole('button', { name: 'Reset password and sign out' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  await waitFor(() => {
    expect(
      within(dialog).getByText('You are not allowed to do this. Only a chief or admin can.'),
    ).toBeTruthy();
  });
  expect(document.body.textContent).not.toContain(secret);
});

test('is a labelled region with keyboard-reachable buttons and a live status region', async () => {
  const user = userEvent.setup();
  renderSection(['CHIEF']);

  const region = await screen.findByRole('region', { name: 'Account security' });
  expect(within(region).getByRole('status')).toBeTruthy();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Report device lost' }));
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Reset password and sign out' }),
  );
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('dialog')).toBeTruthy();
});
