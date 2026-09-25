import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { MapPage } from './MapPage';

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
