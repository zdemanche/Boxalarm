import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import type { Member } from '../personnel/types';
import { AuditLogPage } from './AuditLogPage';
import type { AuditEntry } from './types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'm-1', 'cognito:groups': groups },
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

/** The router's current query string, so a test can read what the page wrote to the URL. */
function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderAuditLog(path = '/audit-log') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['CHIEF'])}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/audit-log"
              element={
                <RequireRole>
                  <AuditLogPage />
                  <LocationProbe />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function member(memberId: string, firstName: string, lastName: string): Member {
  return {
    memberId,
    firstName,
    lastName,
    email: `${memberId}@example.com`,
    phone: null,
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Firefighter',
    agencyId: 'NFD-0001',
  };
}

const ROSTER = [member('m-1', 'Alex', 'Rivera'), member('m-24', 'Olivia', 'Chen')];

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    actorId: 'm-1',
    ts: Date.parse('2026-09-01T14:00:00.000Z'),
    action: 'UPDATE',
    mutatedEntityType: 'MEMBER',
    mutatedEntityId: 'm-24',
    changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
    ...overrides,
  };
}

function membersOk() {
  return http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: ROSTER }));
}

/** The history table's entry rows: not the header row, nor the one-cell loading row. */
function historyRows(): HTMLElement[] {
  const table = screen.queryByRole('table');
  if (!table) return [];
  return within(table)
    .getAllByRole('row')
    .filter((row) => row.querySelectorAll('td').length > 1);
}

function rowText(row: HTMLElement): string {
  return (row.textContent ?? '').replace(/\s+/g, ' ').trim();
}

test('a deep link looks the record up straight away and fills the form', async () => {
  const requests: string[] = [];
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', ({ request }) => {
      requests.push(new URL(request.url).search);
      return HttpResponse.json({ entries: [entry({})] });
    }),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');

  await waitFor(() => expect(historyRows()).toHaveLength(1));
  expect(requests).toEqual(['?entityType=MEMBER&entityId=m-24']);
  expect((screen.getByLabelText('Record type') as HTMLSelectElement).value).toBe('MEMBER');
  expect((screen.getByLabelText('Record ID') as HTMLInputElement).value).toBe('m-24');
  // The subject line names the member the history is about.
  expect(await screen.findByText(/· Olivia Chen/)).toBeTruthy();
});

test('looking a record up writes it to the URL, and a resubmit still refetches', async () => {
  let calls = 0;
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', ({ request }) => {
      calls += 1;
      const url = new URL(request.url);
      expect(url.searchParams.get('entityType')).toBe('EQUIPMENT_ASSET');
      expect(url.searchParams.get('entityId')).toBe('eq-3');
      return HttpResponse.json({
        entries: [
          entry({
            mutatedEntityType: 'EQUIPMENT_ASSET',
            mutatedEntityId: 'eq-3',
            action: 'CREATE',
            changedFields: { serialNumber: { new: 'RADIO-1187' } },
          }),
        ],
      });
    }),
  );

  const user = userEvent.setup();
  renderAuditLog();
  await screen.findByRole('heading', { name: 'Audit log' });
  expect(screen.getByTestId('location').textContent).toBe('');

  await user.selectOptions(screen.getByLabelText('Record type'), 'EQUIPMENT_ASSET');
  // Help text follows the chosen type with an example ID of that kind.
  expect(screen.getByText(/e\.g\. eq-3/)).toBeTruthy();
  // A pasted ID with stray spaces still finds the record.
  await user.type(screen.getByLabelText('Record ID'), ' eq-3 ');
  await user.click(screen.getByRole('button', { name: 'Look up' }));

  await waitFor(() => expect(historyRows()).toHaveLength(1));
  expect(screen.getByTestId('location').textContent).toBe(
    '?entityType=EQUIPMENT_ASSET&entityId=eq-3',
  );
  expect(calls).toBe(1);

  await user.click(screen.getByRole('button', { name: 'Look up' }));
  await waitFor(() => expect(calls).toBe(2));
  await waitFor(() => expect(historyRows()).toHaveLength(1));
});

test('actors show the member’s name with their ID in mono beneath', async () => {
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', () =>
      HttpResponse.json({
        entries: [entry({ actorId: 'm-1' }), entry({ actorId: 'system:expiry-scan', ts: 1 })],
      }),
    ),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');

  await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeTruthy());
  const [first] = historyRows();
  const id = within(first!).getByText('m-1');
  expect(id.className).toMatch(/mono/);
  expect(within(first!).getByText('Alex Rivera')).toBeTruthy();
  expect(screen.getByText('System')).toBeTruthy();
  expect(screen.queryByText(/Member names couldn't be resolved/)).toBeNull();
});

test('when member names cannot be read, rows keep the actor IDs and say so', async () => {
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't1' },
        { status: 503 },
      ),
    ),
    http.get('/api/v1/platform/audit', () =>
      HttpResponse.json({ entries: [entry({ actorId: 'm-1' })] }),
    ),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');

  expect(
    await screen.findByText("Member names couldn't be resolved. IDs are shown instead."),
  ).toBeTruthy();
  const [row] = historyRows();
  expect(within(row!).getByText('m-1')).toBeTruthy();
  expect(screen.queryByText('Alex Rivera')).toBeNull();
});

test('changed fields read as field, old value, arrow, new value', async () => {
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', () =>
      HttpResponse.json({
        entries: [
          entry({
            changedFields: {
              status: { old: 'ACTIVE', new: 'RETIRED' },
              rank: { old: null, new: 'Captain' },
              roles: { old: ['MEMBER'], new: ['MEMBER', 'OFFICER'] },
              pointsByActivityType: { old: { CALL: 1 }, new: { CALL: 2 } },
              location: { new: 'Truck 304' },
            },
          }),
        ],
      }),
    ),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');
  await waitFor(() => expect(historyRows()).toHaveLength(1));

  const item = (field: string) =>
    (screen.getByText(field, { selector: 'span' }).closest('li')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  // Strings unquoted; "to" is the screen reader's word for the arrow.
  expect(item('status')).toBe('status ACTIVE → to RETIRED');
  // Nothing before reads as a dash that a screen reader announces as "none".
  expect(item('rank')).toBe('rank —none → to Captain');
  expect(item('roles')).toBe('roles MEMBER → to MEMBER, OFFICER');
  expect(item('pointsByActivityType')).toBe('pointsByActivityType CALL: 1 → to CALL: 2');
  // A writer that records only the new value: the missing old value is a dash too.
  expect(item('location')).toBe('location —none → to Truck 304');
  expect(screen.queryByText(/"ACTIVE"/)).toBeNull();
});

test('exports and destructive actions carry the alarm glyph and word; edits do not', async () => {
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', ({ request }) => {
      const type = new URL(request.url).searchParams.get('entityType');
      if (type === 'EXPORT_JOB') {
        return HttpResponse.json({
          entries: [
            entry({
              mutatedEntityType: 'EXPORT_JOB',
              mutatedEntityId: 'job-1',
              action: 'CREATE',
              changedFields: {},
            }),
          ],
        });
      }
      return HttpResponse.json({
        entries: [
          entry({ action: 'ARCHIVE', mutatedEntityType: 'HYDRANT', mutatedEntityId: 'HYD-025' }),
          entry({ action: 'UPDATE', mutatedEntityType: 'HYDRANT', ts: 1 }),
        ],
      });
    }),
  );

  renderAuditLog('/audit-log?entityType=EXPORT_JOB&entityId=job-1');
  await waitFor(() => expect(historyRows()).toHaveLength(1));
  const exported = within(historyRows()[0]!).getByText('Exported').closest('[data-status]');
  expect(exported?.getAttribute('data-status')).toBe('danger');
  expect(exported?.querySelector('svg')).toBeTruthy();
  expect(exported?.textContent).toBe('Exported (privileged action)');

  cleanup();
  renderAuditLog('/audit-log?entityType=HYDRANT&entityId=HYD-025');
  await waitFor(() => expect(historyRows()).toHaveLength(2));
  const [archived, updated] = historyRows();
  expect(
    within(archived!).getByText('Archived').closest('[data-status]')?.getAttribute('data-status'),
  ).toBe('danger');
  expect(within(updated!).getByText('Updated').closest('[data-status]')).toBeNull();
});

test('Load more fetches the next page with the cursor and appends older changes', async () => {
  const cursors: (string | null)[] = [];
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      cursors.push(cursor);
      if (!cursor) {
        return HttpResponse.json({
          entries: [entry({ changedFields: { status: { old: 'ACTIVE', new: 'LOA' } } })],
          nextCursor: 'page-2',
        });
      }
      return HttpResponse.json({
        entries: [
          entry({
            ts: Date.parse('2026-08-01T14:00:00.000Z'),
            changedFields: { status: { old: 'PROBATIONARY', new: 'ACTIVE' } },
          }),
        ],
      });
    }),
  );

  const user = userEvent.setup();
  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');
  await waitFor(() => expect(historyRows()).toHaveLength(1));

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(historyRows()).toHaveLength(2));
  expect(cursors).toEqual([null, 'page-2']);
  expect(rowText(historyRows()[1]!)).toContain('PROBATIONARY → to ACTIVE');
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('a record with no history says so plainly', async () => {
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', () => HttpResponse.json({ entries: [] })),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-99');

  expect(await screen.findByText('No change history for this record.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

test('a 403 shows the no-permission state; another failure offers Try again', async () => {
  let status: 403 | 503 | 200 = 403;
  server.use(
    membersOk(),
    http.get('/api/v1/platform/audit', () => {
      if (status === 200) return HttpResponse.json({ entries: [entry({})] });
      const title = status === 403 ? 'Forbidden' : 'Service Unavailable';
      return HttpResponse.json({ type: 'about:blank', title, status, traceId: 't1' }, { status });
    }),
  );

  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');
  // The page itself, not the route guard that shows while the session loads.
  await screen.findByRole('heading', { name: 'Audit log' });
  const forbidden = await screen.findByRole('heading', { name: 'Forbidden' });
  expect(forbidden.tagName).toBe('H2');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

  cleanup();
  status = 503;
  const user = userEvent.setup();
  renderAuditLog('/audit-log?entityType=MEMBER&entityId=m-24');
  const tryAgain = await screen.findByRole('button', { name: 'Try again' });
  status = 200;
  await user.click(tryAgain);
  await waitFor(() => expect(historyRows()).toHaveLength(1));
});
