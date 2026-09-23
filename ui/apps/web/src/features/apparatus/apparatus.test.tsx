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
import { ApparatusDetailPage } from './ApparatusDetailPage';
import { ApparatusListPage } from './ApparatusListPage';
import type { Apparatus } from './types';

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

function renderApp(groups: string[], path = '/apparatus') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/apparatus"
              element={
                <RequireRole>
                  <ApparatusListPage />
                </RequireRole>
              }
            />
            <Route
              path="/apparatus/:id"
              element={
                <RequireRole>
                  <ApparatusDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('APPARATUS create form adds a unit as IN_SERVICE', async () => {
  const items: Apparatus[] = [];
  server.use(
    http.get('/api/v1/apparatus', () => HttpResponse.json({ items })),
    http.post('/api/v1/apparatus', async ({ request }) => {
      const body = (await request.json()) as { unitId: string; type: string };
      const created: Apparatus = {
        apparatusId: 'a-new',
        unitId: body.unitId,
        type: body.type,
        status: 'IN_SERVICE',
      };
      items.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderApp(['APPARATUS']);
  await screen.findByRole('heading', { name: 'Apparatus' });
  await user.type(screen.getByLabelText('Unit ID'), 'E1');
  await user.type(screen.getByLabelText('Type'), 'Engine');
  await user.click(screen.getByRole('button', { name: 'Create apparatus' }));
  await waitFor(() => {
    expect(screen.getByText('E1')).toBeTruthy();
    expect(screen.getByText('IN_SERVICE')).toBeTruthy();
  });
});

test('CHIEF can open registry but does not see create control', async () => {
  server.use(http.get('/api/v1/apparatus', () => HttpResponse.json({ items: [] })));

  renderApp(['CHIEF']);
  await screen.findByRole('heading', { name: 'Apparatus' });
  expect(screen.queryByRole('form', { name: 'Create apparatus' })).toBeNull();
});

test('ADMIN cannot open /apparatus under §7.1 RequireRole', async () => {
  renderApp(['ADMIN']);
  await screen.findByRole('heading', { name: 'Forbidden' });
  expect(screen.queryByRole('form', { name: 'Create apparatus' })).toBeNull();
});

test('detail shows status badge shell', async () => {
  server.use(
    http.get('/api/v1/apparatus/a1', () =>
      HttpResponse.json({
        apparatusId: 'a1',
        unitId: 'L1',
        type: 'Ladder',
        status: 'OUT_OF_SERVICE',
      }),
    ),
  );

  renderApp(['CHIEF'], '/apparatus/a1');
  await screen.findByRole('heading', { name: 'L1' });
  expect(screen.getByRole('status').textContent).toMatch(/Out of service/i);
});
