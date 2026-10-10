import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { toCalendarDate } from '../../lib/dates';
import { RequireRole } from '../../routing/RequireRole';
import { HydrantsPage } from './HydrantsPage';
import type { Hydrant } from './types';

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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['CHIEF'])}>
        <MemoryRouter initialEntries={['/inspections/hydrants']}>
          <Routes>
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

/** The local calendar date `offsetDays` from today, as the API sends it. */
function isoDaysFromToday(offsetDays: number): string {
  const today = new Date();
  return toCalendarDate(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays, 12).getTime(),
  );
}

function hydrant(hydrantId: string, nextFlowTestDue: string): Hydrant {
  return {
    hydrantId,
    latitude: 41.2,
    longitude: -73.2,
    size: '5 inch',
    flowRatingGpm: 1000,
    nextFlowTestDue,
    status: 'IN_SERVICE',
  };
}

test('Mark out of service asks first, naming the hydrant; Cancel sends nothing, confirm does', async () => {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/v1/inspections/hydrants', () =>
      HttpResponse.json({ hydrants: [hydrant('HYD-7', '2099-01-01')] }),
    ),
    http.put('/api/v1/inspections/hydrants/HYD-7', async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({ ...hydrant('HYD-7', '2099-01-01'), status: 'OUT_OF_SERVICE' });
    }),
  );
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('HYD-7');

  await user.click(screen.getByRole('button', { name: 'Mark out of service' }));
  let dialog = await screen.findByRole('dialog', { name: 'Mark hydrant HYD-7 out of service?' });
  expect(dialog.textContent).toContain('inspections map');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(puts).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Mark out of service' }));
  dialog = await screen.findByRole('dialog', { name: 'Mark hydrant HYD-7 out of service?' });
  await user.click(within(dialog).getByRole('button', { name: 'Mark HYD-7 out of service' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(puts).toEqual([{ status: 'OUT_OF_SERVICE' }]);
});

test('a hydrant past its flow-test date is flagged overdue; one inside 30 days is due soon', async () => {
  server.use(
    http.get('/api/v1/inspections/hydrants', () =>
      HttpResponse.json({
        hydrants: [
          hydrant('HYD-1', isoDaysFromToday(-12)),
          hydrant('HYD-2', isoDaysFromToday(9)),
          hydrant('HYD-3', isoDaysFromToday(200)),
        ],
      }),
    ),
  );
  renderPage();
  await screen.findByText('HYD-1');

  const overdue = screen.getByText('Overdue · 12 days');
  expect(overdue.closest('[data-status="danger"]')).toBeTruthy();
  expect(screen.getByText('Due in 9 days').closest('[data-status="warning"]')).toBeTruthy();
  const farRow = screen.getByRole('rowheader', { name: 'HYD-3' }).closest('tr')!;
  expect(within(farRow).queryByText(/Overdue|Due in/)).toBeNull();
  // A human date, never the ISO string.
  expect(within(farRow).queryByText(isoDaysFromToday(200))).toBeNull();
});

test('the register form starts with empty, required coordinates and posts them as numbers', async () => {
  let posted: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/inspections/hydrants', () => HttpResponse.json({ hydrants: [] })),
    http.post('/api/v1/inspections/hydrants', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...posted, status: 'IN_SERVICE' }, { status: 201 });
    }),
  );
  const user = userEvent.setup();
  renderPage();
  const form = await screen.findByRole('form', { name: 'Register hydrant' });
  const latitude = within(form).getByLabelText('Latitude') as HTMLInputElement;
  const longitude = within(form).getByLabelText('Longitude') as HTMLInputElement;
  expect(latitude.value).toBe('');
  expect(longitude.value).toBe('');
  expect(latitude.required).toBe(true);
  expect(longitude.required).toBe(true);

  await user.type(within(form).getByLabelText('Hydrant ID'), 'HYD-30');
  await user.type(latitude, '41.2429');
  await user.type(longitude, '-73.2007');
  await user.type(within(form).getByLabelText('Size'), '6 inch');
  await user.type(within(form).getByLabelText('Flow rating (gpm)'), '1200');
  await user.type(within(form).getByLabelText('Next flow test due'), '2027-05-01');
  await user.click(within(form).getByRole('button', { name: 'Save hydrant' }));

  await waitFor(() =>
    expect(posted).toEqual({
      hydrantId: 'HYD-30',
      latitude: 41.2429,
      longitude: -73.2007,
      size: '6 inch',
      flowRatingGpm: 1200,
      nextFlowTestDue: '2027-05-01',
    }),
  );
});

test("Record flow test stamps today's local date", async () => {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/v1/inspections/hydrants', () =>
      HttpResponse.json({ hydrants: [hydrant('HYD-4', '2099-01-01')] }),
    ),
    http.put('/api/v1/inspections/hydrants/HYD-4', async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json(hydrant('HYD-4', '2099-01-01'));
    }),
  );
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('HYD-4');
  await user.click(screen.getByRole('button', { name: 'Record flow test' }));
  await waitFor(() =>
    expect(puts).toEqual([{ lastFlowTestDate: toCalendarDate(Date.now()), status: 'IN_SERVICE' }]),
  );
});
