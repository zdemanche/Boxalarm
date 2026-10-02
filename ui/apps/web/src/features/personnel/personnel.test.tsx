import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { PersonnelListPage } from './PersonnelListPage';
import { MemberDetailPage } from './MemberDetailPage';
import type { Member } from './types';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

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

function renderPersonnel(groups: string[], path = '/personnel') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/personnel"
              element={
                <RequireRole>
                  <PersonnelListPage />
                </RequireRole>
              }
            />
            <Route
              path="/personnel/:id"
              element={
                <RequireRole>
                  <MemberDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('admin create form posts a member that appears as Probationary', async () => {
  const members: Member[] = [];
  server.use(
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: members })),
    http.post('/api/v1/personnel/members', async ({ request }) => {
      const body = (await request.json()) as Omit<Member, 'memberId' | 'status'>;
      const created: Member = {
        ...body,
        memberId: 'm-new',
        status: 'PROBATIONARY',
      };
      members.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPersonnel(['ADMIN']);
  await screen.findByRole('heading', { name: 'Members' });

  await user.type(screen.getByLabelText('First name'), 'Alex');
  await user.type(screen.getByLabelText('Last name'), 'Rivera');
  await user.type(screen.getByLabelText('Email'), 'alex@example.com');
  await user.type(screen.getByLabelText('Phone'), '203-555-0100');
  await user.type(screen.getByLabelText('Join date'), '2026-01-15');
  await user.type(screen.getByLabelText('Rank'), 'FF');
  await user.type(screen.getByLabelText('Agency ID'), 'NFD-42');
  await user.click(screen.getByRole('button', { name: 'Create member' }));

  await waitFor(() => {
    expect(screen.getByText(/Rivera, Alex/)).toBeTruthy();
    expect(screen.getByText('Probationary')).toBeTruthy();
  });
});

function statusFixture(status: Member['status'] = 'ACTIVE'): {
  member: Member;
  puts: Member['status'][];
} {
  const member: Member = {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status,
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
  };
  const puts: Member['status'][] = [];
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(member)),
    http.put('/api/v1/personnel/members/m1/status', async ({ request }) => {
      const body = (await request.json()) as { status: Member['status'] };
      puts.push(body.status);
      member.status = body.status;
      return HttpResponse.json(member);
    }),
  );
  return { member, puts };
}

// Post-merge MAJOR-2: choosing a status never saves by itself; a confirmation states the
// consequence, and only its confirm button saves.
test('choosing a status alone never saves; LOA is confirmed with its consequence, then applied', async () => {
  const { puts } = statusFixture('ACTIVE');
  const user = userEvent.setup();
  renderPersonnel(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });

  const select = screen.getByLabelText('New member status') as HTMLSelectElement;
  select.focus();
  await user.keyboard('{ArrowDown}{ArrowDown}');
  await user.selectOptions(select, 'LOA');
  expect(puts).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Change status' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('stops receiving all pages');
  expect(dialog.textContent).toContain('signed out of every device until set back to Active');
  expect(puts).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Set leave of absence' }));
  await waitFor(() => expect(puts).toEqual(['LOA']));
  await screen.findByText('Sam Lee is now Leave of absence.');
});

test('cancelling the confirmation saves nothing', async () => {
  const { puts } = statusFixture('ACTIVE');
  const user = userEvent.setup();
  renderPersonnel(['CHIEF'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.selectOptions(screen.getByLabelText('New member status'), 'RETIRED');
  await user.click(screen.getByRole('button', { name: 'Change status' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('permanent');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(puts).toEqual([]);
});

test('offers only the statuses the server accepts: never PROBATIONARY, and RETIRED only back to Active', async () => {
  statusFixture('PROBATIONARY');
  renderPersonnel(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  const options = () =>
    Array.from((screen.getByLabelText('New member status') as HTMLSelectElement).options)
      .map((option) => option.value)
      .filter(Boolean);
  expect(options()).toEqual(['ACTIVE', 'LOA', 'RETIRED']);

  cleanup();
  statusFixture('RETIRED');
  renderPersonnel(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  expect(options()).toEqual(['ACTIVE']);
  expect(screen.getByRole('button', { name: 'Reinstate member' })).toBeTruthy();
});

test('a chief can reinstate a retired member after confirming', async () => {
  const { puts } = statusFixture('RETIRED');
  const user = userEvent.setup();
  renderPersonnel(['CHIEF'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.selectOptions(screen.getByLabelText('New member status'), 'ACTIVE');
  await user.click(screen.getByRole('button', { name: 'Reinstate member' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('paged again');
  await user.click(screen.getByRole('button', { name: 'Reinstate' }));
  await waitFor(() => expect(puts).toEqual(['ACTIVE']));
});

test('an officer has no status control', async () => {
  statusFixture('ACTIVE');
  renderPersonnel(['OFFICER'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  expect(screen.queryByLabelText('New member status')).toBeNull();
});

test('CHIEF can issue PPE, consistent with inspections write-access (MAJOR-3)', async () => {
  const member: Member = {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
  };
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(member)),
    http.get('/api/v1/inventory/ppe/m1', () => HttpResponse.json([])),
  );

  renderPersonnel(['CHIEF'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  expect(screen.getByRole('form', { name: 'Issue PPE' })).toBeTruthy();
});

test('APPARATUS cannot open /personnel under §7.1 RequireRole', async () => {
  renderPersonnel(['APPARATUS']);
  await screen.findByRole('heading', { name: 'Forbidden' });
  expect(screen.queryByRole('form', { name: 'Create member' })).toBeNull();
});

test('forced 403 on detail renders an accessible forbidden state', async () => {
  server.use(
    http.get('/api/v1/personnel/members/m1', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Not permitted',
          traceId: 'trace-xyz',
        },
        { status: 403 },
      ),
    ),
  );

  renderPersonnel(['OFFICER'], '/personnel/m1');
  // RequireRole briefly denies access while AuthProvider's async getUser() is still resolving
  // roles (an unrelated, pre-existing transient state that — with ForbiddenState's message now
  // fixed/generic — renders text identical to the real 403 below). "Loading member…" only ever
  // renders once RequireRole has actually granted access and mounted MemberDetailPage, so
  // waiting for it first anchors the assertions to the real API-driven forbidden state instead
  // of racing the route guard's transient one.
  await screen.findByText('Loading member…');
  await waitFor(() => {
    expect(screen.queryByText('Loading member…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Forbidden' })).toBeTruthy();
  });
  // The 403 body is a fixed generic message — the server's raw detail/traceId (which can leak
  // internal Cedar policy/action names) is intentionally kept out of the rendered DOM.
  expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
  expect(screen.queryByText('trace-xyz')).toBeNull();
});

// Paging review MAJOR-A: an officer sees a member's mark-offs and can end one early.
test('an officer sees the member’s mark-offs and can end one now', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  statusFixture('ACTIVE');
  const ended: string[] = [];
  server.use(
    http.get('/api/v1/personnel/members/m1/availability', () =>
      HttpResponse.json({
        markOffs: [
          {
            markoffId: String(nowSeconds - 60),
            startAt: nowSeconds - 60,
            endAt: nowSeconds + 3600,
          },
        ],
      }),
    ),
    http.post('/api/v1/personnel/members/m1/availability/:markoffId/end', ({ params }) => {
      ended.push(String(params.markoffId));
      return HttpResponse.json({ markoffId: params.markoffId, endedAt: nowSeconds });
    }),
  );
  const user = userEvent.setup();
  renderPersonnel(['OFFICER'], '/personnel/m1');
  await user.click(await screen.findByRole('button', { name: /^End the mark-off/ }));
  await waitFor(() => expect(ended).toEqual([String(nowSeconds - 60)]));
  expect(await screen.findByText(/member is available again/)).toBeTruthy();
});
