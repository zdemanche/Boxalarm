import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { MapPage } from './MapPage';
import { MAX_SPAN_DEGREES, zoomBoundingBox } from './mapProvider';
import type { BoundingBox } from './types';

vi.mock('./leafletMapProvider', () => ({
  leafletMapProvider: {
    MapView: () => <div>Map provider view</div>,
  },
}));

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

test('MapPage renders through the MapProvider port and does not import a map vendor', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/inspections/MapPage.tsx'),
    'utf8',
  );
  expect(source).not.toMatch(/from ['"]leaflet['"]|from ['"]react-leaflet['"]|LeafletMap/);
  expect(source).toContain('leafletMapProvider');
});

test('the map view comes from the provider and an out-of-service hydrant is labeled in the list', async () => {
  server.use(
    http.get('/api/v1/inspections/map', () =>
      HttpResponse.json({
        occupancies: [{ occupancyId: 'OCC-14', latitude: 41.25, longitude: -73.19 }],
        hydrants: [
          {
            hydrantId: 'H-014',
            latitude: 41.251,
            longitude: -73.191,
            status: 'OUT_OF_SERVICE',
          },
        ],
      }),
    ),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['CHIEF'])}>
        <MemoryRouter initialEntries={['/inspections/map']}>
          <Routes>
            <Route
              path="/inspections/map"
              element={
                <RequireRole>
                  <MapPage />
                </RequireRole>
              }
            />
            <Route path="/inspections/occupancies/:id" element={<p>Occupancy</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Map provider view')).toBeTruthy();
  expect(await screen.findByRole('link', { name: 'OCC-14' })).toBeTruthy();
  expect(screen.getByText(/H-014/)).toBeTruthy();
  expect(screen.getByText(/Out of service/)).toBeTruthy();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Pan north' }));
  expect(screen.getByText('Map provider view')).toBeTruthy();
});

function renderMap(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['CHIEF'])}>
        <MemoryRouter initialEntries={['/inspections/map']}>
          <Routes>
            <Route
              path="/inspections/map"
              element={
                <RequireRole>
                  <MapPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('B2-052: zooming out repeatedly never asks for more than 64 precision-5 geohash cells', () => {
  const CELL_DEGREES = 0.0439453125;
  const MAX_COVERING_CELLS = 64;
  let bbox: BoundingBox = { minLat: 41.23, minLng: -73.21, maxLat: 41.27, maxLng: -73.17 };
  for (let i = 0; i < 10; i += 1) bbox = zoomBoundingBox(bbox, 2);
  const latSpan = bbox.maxLat - bbox.minLat;
  const lngSpan = bbox.maxLng - bbox.minLng;
  expect(Math.max(latSpan, lngSpan)).toBeLessThanOrEqual(MAX_SPAN_DEGREES);
  const worstCells =
    (Math.ceil(latSpan / CELL_DEGREES) + 1) * (Math.ceil(lngSpan / CELL_DEGREES) + 1);
  expect(worstCells).toBeLessThanOrEqual(MAX_COVERING_CELLS);
});

test('B2-052: a failed map query keeps the pan and zoom controls on screen', async () => {
  server.use(
    http.get('/api/v1/inspections/map', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Bad Request', status: 400, traceId: 't1' },
        { status: 400 },
      ),
    ),
  );
  renderMap(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy();
});

test('B2-053: remounting on a still-fresh cached query shows the pins again', async () => {
  let requests = 0;
  server.use(
    http.get('/api/v1/inspections/map', () => {
      requests += 1;
      return HttpResponse.json({
        occupancies: [{ occupancyId: 'OCC-14', latitude: 41.25, longitude: -73.19 }],
        hydrants: [
          { hydrantId: 'H-014', latitude: 41.251, longitude: -73.191, status: 'IN_SERVICE' },
        ],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });

  renderMap(client);
  expect(await screen.findByRole('link', { name: 'OCC-14' })).toBeTruthy();
  cleanup();

  renderMap(client);
  expect(await screen.findByRole('link', { name: 'OCC-14' })).toBeTruthy();
  expect(screen.getByText(/H-014/)).toBeTruthy();
  await waitFor(() => expect(requests).toBe(1));
});
