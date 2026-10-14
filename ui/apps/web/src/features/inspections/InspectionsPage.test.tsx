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
import { InspectionsPage } from './InspectionsPage';
import type { Inspection } from './types';

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
        <MemoryRouter initialEntries={['/inspections']}>
          <Routes>
            <Route
              path="/inspections"
              element={
                <RequireRole>
                  <InspectionsPage />
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

const OCCUPANCIES = [
  { occupancyId: 'occ-1', address: '12 Main St', occupancyType: 'Mercantile' },
  { occupancyId: 'occ-2', address: '9 Elm St', occupancyType: 'Residential' },
  { occupancyId: 'occ-3', address: '4 Oak Ave', occupancyType: 'Assembly' },
].map((o) => ({ ...o, contacts: [], hazards: [] }));

function inspection(
  inspectionId: string,
  occupancyId: string,
  nextDueDate: string,
  extra: Partial<Inspection> = {},
): Inspection {
  return {
    inspectionId,
    occupancyId,
    scheduledDate: nextDueDate,
    nextDueDate,
    violations: [],
    ...extra,
  };
}

test('inspections render as a table, soonest due first, with overdue/due-soon/conducted chips', async () => {
  const conductedOn = isoDaysFromToday(-20);
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'member-7', firstName: 'Luis', lastName: 'Ortega' }],
      }),
    ),
    http.get('/api/v1/inspections', () =>
      HttpResponse.json({
        items: [
          inspection('insp-soon', 'occ-2', isoDaysFromToday(6)),
          // Conducted: the service leaves nextDueDate at the (past) scheduled date.
          inspection('insp-done', 'occ-3', conductedOn, {
            conductedDate: `${conductedOn}T15:00:00.000Z`,
            conductedBy: 'member-7',
            violations: [{ code: 'NFPA 58 8.4.1', description: 'Tank', status: 'open' }],
          }),
          inspection('insp-late', 'occ-1', isoDaysFromToday(-35)),
        ],
      }),
    ),
  );
  renderPage();

  const table = await screen.findByRole('table', { name: 'Inspections due' });
  await within(table).findByRole('rowheader', { name: '12 Main St (Mercantile)' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
    '12 Main St (Mercantile)',
    '4 Oak Ave (Assembly)',
    '9 Elm St (Residential)',
  ]);

  expect(
    within(rows[0]!).getByText('Overdue · 35 days').closest('[data-status="danger"]'),
  ).toBeTruthy();
  expect(within(rows[1]!).getByText('Conducted').closest('[data-status="ok"]')).toBeTruthy();
  expect(rows[1]!.textContent).toContain('by Luis Ortega');
  expect(rows[1]!.textContent).not.toContain('member-7');
  expect(within(rows[1]!).queryByRole('button', { name: 'Conduct' })).toBeNull();
  expect(within(rows[0]!).getByRole('button', { name: 'Conduct' })).toBeTruthy();
  expect(rows[1]!.textContent).toContain('NFPA 58 8.4.1 (Open)');
  expect(
    within(rows[2]!).getByText('Due in 6 days').closest('[data-status="warning"]'),
  ).toBeTruthy();
  // Human dates, never the ISO strings the service sends.
  expect(table.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

test('Conduct opens a dialog naming the occupancy; saving posts the violations and closes it', async () => {
  let posted: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/inspections', () =>
      HttpResponse.json({ items: [inspection('insp-1', 'occ-1', isoDaysFromToday(3))] }),
    ),
    http.post('/api/v1/inspections', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(inspection('insp-1', 'occ-1', isoDaysFromToday(3)));
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Conduct' }));
  const dialog = await screen.findByRole('dialog', { name: 'Conduct inspection' });
  expect(dialog.textContent).toContain('12 Main St (Mercantile)');
  await user.click(within(dialog).getByRole('button', { name: 'Add violation' }));
  await user.type(within(dialog).getByLabelText('Code'), 'V-1');
  await user.type(within(dialog).getByLabelText('Description'), 'Blocked exit');
  await user.click(within(dialog).getByRole('button', { name: 'Save conduct' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posted).toEqual({
    occupancyId: 'occ-1',
    inspectionId: 'insp-1',
    violations: [{ code: 'V-1', description: 'Blocked exit', status: 'open' }],
  });
});

test('a failed conduct save stays in the dialog and says so', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/inspections', () =>
      HttpResponse.json({ items: [inspection('insp-1', 'occ-1', isoDaysFromToday(3))] }),
    ),
    http.post('/api/v1/inspections', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Conduct' }));
  const dialog = await screen.findByRole('dialog', { name: 'Conduct inspection' });
  await user.click(within(dialog).getByRole('button', { name: 'Save conduct' }));
  expect((await within(dialog).findByRole('alert')).textContent).toContain(
    'The inspection was not saved',
  );
});

// Review MAJOR: the service never moves nextDueDate when an inspection is conducted, so one done
// ahead of its scheduled date fell through to "Due in N days" - finished work flagged as due.
test('an inspection conducted before its scheduled date reads Conducted, not due', async () => {
  const doneOn = isoDaysFromToday(-1);
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/inspections', () =>
      HttpResponse.json({
        items: [
          inspection('insp-early', 'occ-2', isoDaysFromToday(5), {
            conductedDate: `${doneOn}T15:00:00.000Z`,
            conductedBy: 'member-7',
          }),
        ],
      }),
    ),
  );
  renderPage();

  const table = await screen.findByRole('table', { name: 'Inspections due' });
  const row = (await within(table).findByRole('rowheader', { name: '9 Elm St (Residential)' }))
    .parentElement!;
  expect(within(row).getByText('Conducted').closest('[data-status="ok"]')).toBeTruthy();
  expect(within(row).queryByText(/Due in/)).toBeNull();
});

test('B2-054: the page asks for a year-long horizon and shows an inspection 60 days out as Scheduled', async () => {
  let requestedUrl: URL | undefined;
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/inspections', ({ request }) => {
      requestedUrl = new URL(request.url);
      return HttpResponse.json({ items: [inspection('insp-far', 'occ-1', isoDaysFromToday(60))] });
    }),
  );
  renderPage();

  const table = await screen.findByRole('table', { name: 'Inspections due' });
  await within(table).findByRole('rowheader', { name: '12 Main St (Mercantile)' });
  expect(requestedUrl?.searchParams.get('leadDays')).toBe('365');
  expect(requestedUrl?.searchParams.has('month')).toBe(false);
  expect(within(table).getByText('Scheduled')).toBeTruthy();
});

test('B2-192: a conducted-by id that matches no member reads "by a member", never the raw id', async () => {
  const doneOn = isoDaysFromToday(-1);
  server.use(
    http.get('/api/v1/inspections/occupancies', () => HttpResponse.json({ items: OCCUPANCIES })),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
    http.get('/api/v1/inspections', () =>
      HttpResponse.json({
        items: [
          inspection('insp-x', 'occ-2', doneOn, {
            conductedDate: `${doneOn}T15:00:00.000Z`,
            conductedBy: 'member-9',
          }),
        ],
      }),
    ),
  );
  renderPage();

  const table = await screen.findByRole('table', { name: 'Inspections due' });
  const row = (await within(table).findByRole('rowheader', { name: '9 Elm St (Residential)' }))
    .parentElement!;
  await waitFor(() => expect(row.textContent).toContain('by a member'));
  expect(row.textContent).not.toContain('member-9');
});
