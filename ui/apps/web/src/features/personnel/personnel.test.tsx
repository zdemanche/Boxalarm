import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
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
            <Route path="/personnel" element={<PersonnelListPage />} />
            <Route path="/personnel/:id" element={<MemberDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('admin create form posts a member that appears as PROBATIONARY', async () => {
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
  await screen.findByRole('heading', { name: 'Personnel' });

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
    expect(screen.getByText('PROBATIONARY')).toBeTruthy();
  });
});

test('admin can change status on detail without full reload; non-admin has no control', async () => {
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
    http.put('/api/v1/personnel/members/m1/status', async ({ request }) => {
      const body = (await request.json()) as { status: Member['status'] };
      member.status = body.status;
      return HttpResponse.json(member);
    }),
  );

  const user = userEvent.setup();
  renderPersonnel(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.selectOptions(screen.getByLabelText('Member status'), 'LOA');
  await waitFor(() => {
    expect((screen.getByLabelText('Member status') as HTMLSelectElement).value).toBe('LOA');
  });

  cleanup();
  renderPersonnel(['OFFICER'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  expect(screen.queryByLabelText('Member status')).toBeNull();
});

test('forced 403 on detail renders accessible forbidden state with traceId', async () => {
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
  await screen.findByRole('heading', { name: 'Forbidden' });
  expect(screen.getByText('trace-xyz')).toBeTruthy();
});
