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
import { EquipmentDetailPage } from './EquipmentDetailPage';
import { EquipmentPage } from './EquipmentPage';
import type { EquipmentAsset } from './types';

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

function renderApp(groups: string[], path = '/inventory') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/inventory"
              element={
                <RequireRole>
                  <EquipmentPage />
                </RequireRole>
              }
            />
            <Route
              path="/inventory/:assetId"
              element={
                <RequireRole>
                  <EquipmentDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('registering an asset lists it as unassigned (AC1)', async () => {
  const items: EquipmentAsset[] = [];
  server.use(
    http.get('/api/v1/inventory/equipment', () => HttpResponse.json({ items })),
    http.post('/api/v1/inventory/equipment', async ({ request }) => {
      const body = (await request.json()) as { serialNumber: string; location: string };
      const created: EquipmentAsset = {
        assetId: 'eq-new',
        deptId: 'd1',
        serialNumber: body.serialNumber,
        location: body.location,
        lifecycleStatus: 'ACQUIRED',
      };
      items.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderApp(['ADMIN']);
  await screen.findByRole('heading', { name: 'Inventory' });
  await user.type(screen.getByLabelText('Serial number'), 'SCBA-9001');
  await user.click(screen.getByRole('button', { name: 'Register asset' }));
  await waitFor(() => {
    expect(screen.getByText('SCBA-9001')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
  });
});

test('assignment shows on the asset detail (AC2)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-1',
    deptId: 'd1',
    serialNumber: 'SCBA-1',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  };
  let current = asset;
  server.use(
    http.get('/api/v1/inventory/equipment/eq-1', () => HttpResponse.json(current)),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [
          {
            memberId: 'm-1',
            firstName: 'Alex',
            lastName: 'Rivera',
            email: 'alex@example.com',
            phone: '203-555-0100',
            status: 'ACTIVE',
            joinDate: '2020-01-01',
            rank: 'FF',
            agencyId: 'NFD-1',
          },
        ],
      }),
    ),
    http.put('/api/v1/inventory/equipment/eq-1/assignment', async ({ request }) => {
      const body = (await request.json()) as Pick<
        EquipmentAsset,
        'assignedToType' | 'assignedToId'
      >;
      current = { ...current, ...body };
      return HttpResponse.json(current);
    }),
  );

  const user = userEvent.setup();
  renderApp(['ADMIN'], '/inventory/eq-1');
  await screen.findByRole('heading', { name: 'SCBA-1' });
  await user.selectOptions(await screen.findByLabelText('Member'), 'm-1');
  await user.click(screen.getByRole('button', { name: 'Save assignment' }));
  await waitFor(() => {
    expect(screen.getByText('MEMBER · m-1')).toBeTruthy();
  });
});

test('the member picker only offers members from the loaded list — no freeform ID entry (MAJOR-1)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-1',
    deptId: 'd1',
    serialNumber: 'SCBA-1',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  };
  server.use(
    http.get('/api/v1/inventory/equipment/eq-1', () => HttpResponse.json(asset)),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [
          {
            memberId: 'm-1',
            firstName: 'Alex',
            lastName: 'Rivera',
            email: 'alex@example.com',
            phone: '203-555-0100',
            status: 'ACTIVE',
            joinDate: '2020-01-01',
            rank: 'FF',
            agencyId: 'NFD-1',
          },
        ],
      }),
    ),
  );

  renderApp(['ADMIN'], '/inventory/eq-1');
  await screen.findByRole('heading', { name: 'SCBA-1' });
  const picker = (await screen.findByLabelText('Member')) as HTMLSelectElement;
  expect(picker.tagName).toBe('SELECT');
  const optionValues = Array.from(picker.options).map((option) => option.value);
  expect(optionValues).toEqual(['', 'm-1']);
});

test('location change leaves assignment unchanged (AC3)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-1',
    deptId: 'd1',
    serialNumber: 'SCBA-1',
    assignedToType: 'MEMBER',
    assignedToId: 'm-1',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  };
  let current = asset;
  server.use(
    http.get('/api/v1/inventory/equipment/eq-1', () => HttpResponse.json(current)),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
    http.put('/api/v1/inventory/equipment/eq-1/location', async ({ request }) => {
      const body = (await request.json()) as { location: string };
      current = { ...current, location: body.location };
      return HttpResponse.json(current);
    }),
  );

  const user = userEvent.setup();
  renderApp(['ADMIN'], '/inventory/eq-1');
  await screen.findByRole('heading', { name: 'SCBA-1' });
  await user.type(screen.getByLabelText('New location'), 'Station 2');
  await user.click(screen.getByRole('button', { name: 'Save location' }));
  await waitFor(() => {
    expect(screen.getByText('Station 2')).toBeTruthy();
    expect(screen.getByText('MEMBER · m-1')).toBeTruthy();
  });
});

test('a retired asset no longer appears when show retired is off, and its assign form is disabled (AC2 lifecycle)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-9',
    deptId: 'd1',
    serialNumber: 'RETIRED-1',
    location: 'Station 1',
    lifecycleStatus: 'RETIRED',
  };
  server.use(
    http.get('/api/v1/inventory/equipment/eq-9', () => HttpResponse.json(asset)),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderApp(['ADMIN'], '/inventory/eq-9');
  await screen.findByRole('heading', { name: 'RETIRED-1' });
  expect((screen.getByLabelText('Member') as HTMLSelectElement).disabled).toBe(true);
});

test('a non-admin viewer sees no lifecycle transition control (AC3)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-1',
    deptId: 'd1',
    serialNumber: 'SCBA-1',
    location: 'Station 1',
    lifecycleStatus: 'ACQUIRED',
  };
  server.use(http.get('/api/v1/inventory/equipment/eq-1', () => HttpResponse.json(asset)));

  renderApp(['APPARATUS'], '/inventory/eq-1');
  await screen.findByRole('heading', { name: 'SCBA-1' });
  expect(screen.queryByRole('button', { name: /Move to/ })).toBeNull();
});

test('CHIEF has the same equipment write access as ADMIN, consistent with inspections (MAJOR-3)', async () => {
  const asset: EquipmentAsset = {
    assetId: 'eq-1',
    deptId: 'd1',
    serialNumber: 'SCBA-1',
    location: 'Station 1',
    lifecycleStatus: 'IN_SERVICE',
  };
  server.use(
    http.get('/api/v1/inventory/equipment', () => HttpResponse.json({ items: [] })),
    http.get('/api/v1/inventory/equipment/eq-1', () => HttpResponse.json(asset)),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderApp(['CHIEF']);
  await screen.findByRole('heading', { name: 'Inventory' });
  expect(screen.getByRole('form', { name: 'Register equipment' })).toBeTruthy();

  cleanup();
  renderApp(['CHIEF'], '/inventory/eq-1');
  await screen.findByRole('heading', { name: 'SCBA-1' });
  expect(screen.getByRole('form', { name: 'Assign asset' })).toBeTruthy();
});

test('below-threshold consumables are flagged (AC1)', async () => {
  server.use(
    http.get('/api/v1/inventory/equipment', () => HttpResponse.json({ items: [] })),
    http.get('/api/v1/inventory/consumables', () =>
      HttpResponse.json({
        items: [
          {
            itemId: 'foam',
            deptId: 'd1',
            itemName: 'Foam',
            stockLevel: 1,
            reorderThreshold: 5,
            reorderFlagged: true,
          },
        ],
      }),
    ),
  );

  const user = userEvent.setup();
  renderApp(['ADMIN']);
  await screen.findByRole('heading', { name: 'Inventory' });
  await user.click(screen.getByRole('tab', { name: 'Consumables' }));
  await waitFor(() => {
    expect(screen.getByText('⚠ Reorder needed')).toBeTruthy();
  });
});
