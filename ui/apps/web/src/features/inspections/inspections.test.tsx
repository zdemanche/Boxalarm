import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  // Scoped to the details list: the hazards editor below is pre-filled with the same text.
  expect(screen.getByText('Propane tank', { selector: 'dd' })).toBeTruthy();
});

test('an officer gets the create controls the Cedar policy grants (AC4)', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: [] })),
    http.get('/api/v1/inspections/hydrants', () => HttpResponse.json({ items: [] })),
  );

  const { unmount } = renderApp(['OFFICER'], '/inspections/occupancies');
  await screen.findByRole('heading', { name: 'Occupancies' });
  expect(screen.getByRole('form', { name: 'Register occupancy' })).toBeTruthy();
  unmount();

  renderApp(['OFFICER'], '/inspections/hydrants');
  expect(await screen.findByRole('form', { name: 'Register hydrant' })).toBeTruthy();
});

test('a member cannot open the occupancy page at all (AC4)', async () => {
  renderApp(['MEMBER'], '/inspections/occupancies');
  expect(await screen.findByRole('heading', { name: /forbidden|access/i })).toBeTruthy();
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

  const diagramInput = (await screen.findByLabelText('Site diagram')) as HTMLInputElement;
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

test('N10: a rejected "Mark out of service" is shown, never silent (409 conflict and 503)', async () => {
  const hydrant = {
    hydrantId: 'HYD-2',
    latitude: 41.2,
    longitude: -73.2,
    size: '6 inch',
    flowRatingGpm: 1000,
    nextFlowTestDue: '2027-01-01',
    status: 'IN_SERVICE',
  };
  let status = 409;
  server.use(
    http.get('/api/v1/inspections/hydrants', () => HttpResponse.json({ hydrants: [hydrant] })),
    http.put('/api/v1/inspections/hydrants/HYD-2', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Hydrant update conflict', status, traceId: 't-1' },
        { status },
      ),
    ),
  );
  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/hydrants');
  await screen.findByText('HYD-2');

  // The action is confirmed first (design §4.5); a rejection stays in the dialog with the reason.
  await user.click(screen.getByRole('button', { name: 'Mark out of service' }));
  const dialog = await screen.findByRole('dialog', { name: 'Mark hydrant HYD-2 out of service?' });
  await user.click(within(dialog).getByRole('button', { name: 'Mark HYD-2 out of service' }));
  expect((await within(dialog).findByRole('alert')).textContent).toContain(
    'HYD-2 was changed by someone else just now',
  );

  status = 503;
  await user.click(within(dialog).getByRole('button', { name: 'Mark HYD-2 out of service' }));
  expect((await within(dialog).findByText(/not saved \(HTTP 503\)/)).textContent).toContain(
    'Marking out of service for HYD-2 was not saved',
  );
});

test('round-3 minor 4: the occupancy address field tells inspectors to include an out-of-area town', async () => {
  server.use(http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: [] })));
  renderApp(['CHIEF'], '/inspections/occupancies');
  const address = await screen.findByLabelText(/^Address/);
  const help = document.getElementById(address.getAttribute('aria-describedby') ?? '');
  expect(help?.textContent).toContain('Include the town');
});

async function fillRegisterForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/^Address/), '12 Oak St');
  await user.type(screen.getByLabelText(/^Occupancy type/), 'Mercantile');
}

function serveCreate() {
  const posted: Record<string, unknown>[] = [];
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: [] })),
    http.post('/api/v1/inspections/occupancies', async ({ request }) => {
      posted.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ occupancyId: 'occ-9' }, { status: 201 });
    }),
  );
  return posted;
}

test('X-020: a registered occupancy carries the coordinates typed into the form', async () => {
  const posted = serveCreate();
  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/occupancies');
  await fillRegisterForm(user);
  await user.type(screen.getByLabelText(/^Latitude/), '41.2');
  await user.type(screen.getByLabelText(/^Longitude/), '-73.19');
  await user.click(screen.getByRole('button', { name: 'Save occupancy' }));

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toMatchObject({ latitude: 41.2, longitude: -73.19 });
});

test('X-020: leaving both coordinates empty omits them from the create body', async () => {
  const posted = serveCreate();
  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/occupancies');
  await fillRegisterForm(user);
  await user.click(screen.getByRole('button', { name: 'Save occupancy' }));

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).not.toHaveProperty('latitude');
  expect(posted[0]).not.toHaveProperty('longitude');
});

test('X-020: one coordinate without the other, or one out of range, is refused before any request', async () => {
  const posted = serveCreate();
  const user = userEvent.setup();
  renderApp(['CHIEF'], '/inspections/occupancies');
  await fillRegisterForm(user);
  await user.type(screen.getByLabelText(/^Latitude/), '41.2');
  await user.click(screen.getByRole('button', { name: 'Save occupancy' }));
  expect(await screen.findByText(/both latitude and longitude/i)).toBeTruthy();

  await user.type(screen.getByLabelText(/^Longitude/), '-273');
  await user.click(screen.getByRole('button', { name: 'Save occupancy' }));
  expect(posted).toHaveLength(0);
});
