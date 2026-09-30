import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { SchedulePage } from './SchedulePage';

const server = setupServer(
  http.get('/api/v1/personnel/shifts/coverage', () => HttpResponse.json({ shifts: [] })),
  http.get('/api/v1/personnel/shifts/swaps/pending', () => HttpResponse.json({ swaps: [] })),
  http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  http.get('/api/v1/platform/config/STATIONS', () =>
    HttpResponse.json(
      { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't' },
      { status: 404 },
    ),
  ),
);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'officer-1', 'cognito:groups': ['OFFICER'] },
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

function renderSchedule() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager()}>
        <SchedulePage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// DUTY_SHIFT.startAt/endAt are epoch milliseconds on the backend (coverage and claim compare
// them with Date.now()); the page used to send and read seconds.
test('creates a shift with epoch-millisecond start/end', async () => {
  let posted: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/personnel/shifts', () => HttpResponse.json({ shifts: [] })),
    http.post('/api/v1/personnel/shifts', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ shiftId: 's-9' }, { status: 201 });
    }),
  );
  renderSchedule();

  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Start'), '2026-10-01T18:00');
  await user.type(screen.getByLabelText('End'), '2026-10-02T06:00');
  await user.type(screen.getByLabelText('Station'), 'STATION-1');
  await user.click(screen.getByRole('button', { name: 'Create shift' }));

  await waitFor(() => expect(posted).toBeDefined());
  expect(posted?.startAt).toBe(new Date('2026-10-01T18:00').getTime());
  expect(posted?.endAt).toBe(new Date('2026-10-02T06:00').getTime());
});

test('renders a listed shift from its epoch-millisecond startAt', async () => {
  const startAt = new Date('2026-10-01T18:00').getTime();
  server.use(
    http.get('/api/v1/personnel/shifts', () =>
      HttpResponse.json({
        shifts: [
          {
            shiftId: 's-1',
            startAt,
            endAt: startAt + 43_200_000,
            stationId: 'STATION-1',
            status: 'OPEN',
          },
        ],
      }),
    ),
  );
  renderSchedule();

  expect(await screen.findByText(/Open$/)).toBeTruthy();
  expect(screen.queryByText(/OPEN/)).toBeNull();
});

test('stations are picked by name when the department has set them up', async () => {
  server.use(
    http.get('/api/v1/personnel/shifts', () => HttpResponse.json({ shifts: [] })),
    http.get('/api/v1/platform/config/STATIONS', () =>
      HttpResponse.json({
        configType: 'STATIONS',
        value: { stations: [{ stationId: 'st-1', name: 'Station 1 — Nichols' }] },
        version: 1,
        updatedAt: '2026-08-01T00:00:00Z',
        updatedBy: 'a',
      }),
    ),
  );
  renderSchedule();

  const station = await screen.findByRole('combobox', { name: 'Station' });
  expect(within(station).getByRole('option', { name: 'Station 1 — Nichols' })).toBeTruthy();
});

test('a pending swap is approved from its row, by name, with no ids typed', async () => {
  let approvedPath: string | undefined;
  server.use(
    http.get('/api/v1/personnel/shifts', () => HttpResponse.json({ shifts: [] })),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [
          { memberId: 'm-3', firstName: 'Casey', lastName: 'Nolan' },
          { memberId: 'm-2', firstName: 'Jordan', lastName: 'Osei' },
        ],
      }),
    ),
    http.get('/api/v1/personnel/shifts/swaps/pending', () =>
      HttpResponse.json({
        swaps: [
          {
            shiftId: 's-7',
            positionCode: 'DRIVER',
            fromMemberId: 'm-3',
            toMemberId: 'm-2',
            status: 'PENDING',
            requiresOfficerApproval: true,
            requestedAt: 1758300000000,
          },
        ],
      }),
    ),
    http.post('/api/v1/personnel/shifts/:shiftId/swap/:swapId/approve', ({ request }) => {
      approvedPath = new URL(request.url).pathname;
      return HttpResponse.json({
        shiftId: 's-7',
        swapId: 1758300000000,
        status: 'APPROVED',
        claimedByMemberId: 'm-2',
      });
    }),
  );
  renderSchedule();

  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', {
      name: 'Approve swap: Casey Nolan to Jordan Osei, DRIVER',
    }),
  );

  await screen.findByText('Swap approved.');
  expect(approvedPath).toBe('/api/v1/personnel/shifts/s-7/swap/1758300000000/approve');
  expect(screen.queryByLabelText('Swap ID')).toBeNull();
});
