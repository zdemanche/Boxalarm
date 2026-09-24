import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { HydrantsPage } from './HydrantsPage';
import { OccupancyDetailPage } from './OccupancyDetailPage';
import { OccupancyListPage } from './OccupancyListPage';

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

function renderApp(groups: string[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/inspections/occupancies"
              element={
                <RequireRole>
                  <OccupancyListPage />
                </RequireRole>
              }
            />
            <Route
              path="/inspections/occupancies/:id"
              element={
                <RequireRole>
                  <OccupancyDetailPage />
                </RequireRole>
              }
            />
            <Route
              path="/inspections/hydrants"
              element={
                <RequireRole>
                  <HydrantsPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('occupancy detail shows address, type, contacts, hazards after create (AC1, AC2)', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () =>
      HttpResponse.json({
        occupancyId: 'occ-1',
        address: '9 Elm St',
        occupancyType: 'Residential',
        contacts: [{ name: 'Pat Doyle', phone: '203-555-0100', role: 'Owner' }],
        hazards: ['Propane tank'],
      }),
    ),
  );

  renderApp(['CHIEF'], '/inspections/occupancies/occ-1');
  await screen.findByRole('heading', { name: '9 Elm St' });
  expect(screen.getByText('Residential')).toBeTruthy();
  expect(screen.getByText('Pat Doyle (Owner) 203-555-0100')).toBeTruthy();
  expect(screen.getByText('Propane tank')).toBeTruthy();
});

test('a member without write permission sees no create controls (AC4)', async () => {
  server.use(http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: [] })));

  renderApp(['OFFICER'], '/inspections/occupancies');
  await screen.findByRole('heading', { name: 'Occupancies' });
  expect(screen.queryByRole('form', { name: 'Register occupancy' })).toBeNull();
});

test('a forced write without permission renders the 403 problem (AC4)', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () =>
      HttpResponse.json({
        occupancyId: 'occ-1',
        address: '9 Elm St',
        occupancyType: 'Residential',
        contacts: [],
        hazards: [],
      }),
    ),
    http.put('/api/v1/inspections/occupancies/occ-1', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't1' },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/occupancies/occ-1');
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.type(screen.getByLabelText('Hazards (one per line)'), 'Forced write');
  await user.click(screen.getByRole('button', { name: 'Save hazards' }));
  await screen.findByRole('heading', { name: 'Forbidden' });
});

test('pre-plan file inputs restrict type and reject oversized files client-side (MAJOR-2)', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () =>
      HttpResponse.json({
        occupancyId: 'occ-1',
        address: '9 Elm St',
        occupancyType: 'Residential',
        contacts: [],
        hazards: [],
      }),
    ),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/occupancies/occ-1');
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));

  const diagramInput = screen.getByLabelText('Site diagram') as HTMLInputElement;
  expect(diagramInput.accept).toContain('application/pdf');
  expect(diagramInput.accept).toContain('image/png');

  const oversizedFile = new File([new Uint8Array(21 * 1024 * 1024)], 'floorplan.pdf', {
    type: 'application/pdf',
  });
  await user.upload(diagramInput, oversizedFile);

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('floorplan.pdf');
  expect(alert.textContent).toContain('larger than the 20MB limit');
  expect(diagramInput.files?.length ?? 0).toBe(0);
});

test('an out-of-service hydrant is distinguished by text and icon, not color alone (AC3)', async () => {
  server.use(
    http.get('/api/v1/inspections/hydrants', () =>
      HttpResponse.json({
        hydrants: [
          {
            hydrantId: 'HYD-1',
            latitude: 41.2,
            longitude: -73.2,
            size: '5 inch',
            flowRatingGpm: 900,
            nextFlowTestDue: '2027-01-01',
            status: 'OUT_OF_SERVICE',
          },
        ],
      }),
    ),
  );

  renderApp(['CHIEF'], '/inspections/hydrants');
  await screen.findByText('HYD-1');
  const statusChip = screen.getByText('Out of service');
  expect(statusChip.closest('[data-status="danger"]')).toBeTruthy();
});
