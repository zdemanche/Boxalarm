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
import { AlertsRosterPage } from './AlertsRosterPage';

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

function renderPage(groups: string[], path = '/alerts/roster') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/alerts/roster"
              element={
                <RequireRole>
                  <AlertsRosterPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('a member cannot open /alerts/roster', async () => {
  renderPage(['MEMBER']);
  await screen.findByRole('heading', { name: 'Forbidden' });
});

test('an officer sees the manual entry form and, given a dispatch id, the roster and receipts', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-1', () =>
      HttpResponse.json({
        dispatchId: 'D-1',
        incidentType: 'Structure fire',
        address: '18 Nichols Ave',
        crossStreets: 'Main & Nichols',
        mapLink: null,
        narrative: 'Smoke showing',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-1/roster', () =>
      HttpResponse.json({
        members: [
          {
            memberId: 'm-1',
            name: 'Jordan Osei',
            ackStatus: 'DIRECT_TO_SCENE',
            eta: null,
            assignedApparatusId: null,
            quals: ['FF1'],
            lastAnsweredTone: 1,
          },
        ],
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-1/receipts', () =>
      HttpResponse.json({
        receipts: [
          {
            memberId: 'm-1',
            channel: 'PUSH',
            toneSequence: 1,
            status: 'SENT_UNCONFIRMED',
            sentAt: 0,
            deliveredAt: null,
            openedAt: null,
            failureReason: null,
          },
        ],
      }),
    ),
    http.get('/api/v1/apparatus/riding-board/D-1', () =>
      HttpResponse.json({ dispatchId: 'D-1', apparatus: [] }),
    ),
  );

  renderPage(['OFFICER'], '/alerts/roster?dispatchId=D-1');

  expect(await screen.findByRole('form', { name: 'Enter dispatch manually' })).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Structure fire' })).toBeTruthy();
  expect(await screen.findByText('Jordan Osei')).toBeTruthy();
  expect(await screen.findByText('Direct to scene')).toBeTruthy();
  expect(await screen.findByText('Sent, not confirmed delivered')).toBeTruthy();
});

test('submitting the manual entry form navigates the page to the new dispatch id', async () => {
  server.use(
    http.post('/api/v1/alerting/dispatches', async () =>
      HttpResponse.json({ dispatchId: 'D-9' }, { status: 201 }),
    ),
    http.get('/api/v1/alerting/dispatches/D-9', () =>
      HttpResponse.json({
        dispatchId: 'D-9',
        incidentType: 'MVA',
        address: '1 Main St',
        crossStreets: '',
        mapLink: null,
        narrative: '',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-9/roster', () => HttpResponse.json({ members: [] })),
    http.get('/api/v1/alerting/dispatches/D-9/receipts', () => HttpResponse.json({ receipts: [] })),
    http.get('/api/v1/apparatus/riding-board/D-9', () =>
      HttpResponse.json({ dispatchId: 'D-9', apparatus: [] }),
    ),
  );

  const user = userEvent.setup();
  renderPage(['CHIEF']);

  await user.type(await screen.findByLabelText('Incident type'), 'MVA');
  await user.type(screen.getByLabelText('Address'), '1 Main St');
  await user.type(screen.getByLabelText('Cross streets'), 'N/A');
  await user.type(screen.getByLabelText('Narrative'), 'MVA with injuries');
  await user.type(screen.getByLabelText('Operator-entered reference'), 'ext-9');
  await user.click(screen.getByRole('button', { name: 'Submit dispatch' }));

  await waitFor(() => expect(screen.getByRole('heading', { name: 'MVA' })).toBeTruthy());
});

test('a failed riding-board seat assignment surfaces an error instead of silently reverting', async () => {
  server.use(
    http.get('/api/v1/alerting/dispatches/D-2', () =>
      HttpResponse.json({
        dispatchId: 'D-2',
        incidentType: 'Structure fire',
        address: '18 Nichols Ave',
        crossStreets: '',
        mapLink: null,
        narrative: '',
        prePlan: null,
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-2/roster', () =>
      HttpResponse.json({
        members: [
          {
            memberId: 'm-1',
            name: 'Jordan Osei',
            ackStatus: 'RESPONDING',
            eta: null,
            assignedApparatusId: null,
            quals: ['FF1'],
            lastAnsweredTone: 1,
          },
        ],
      }),
    ),
    http.get('/api/v1/alerting/dispatches/D-2/receipts', () => HttpResponse.json({ receipts: [] })),
    http.get('/api/v1/apparatus/riding-board/D-2', () =>
      HttpResponse.json({
        dispatchId: 'D-2',
        apparatus: [
          {
            apparatusId: 'a-301',
            unitId: 'Engine 301',
            type: 'Engine',
            status: 'IN_SERVICE',
            assignable: true,
            positions: [{ code: 'OFF', label: 'Officer' }],
          },
        ],
      }),
    ),
    http.post('/api/v1/apparatus/riding-board/D-2/assign', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This seat was already assigned.',
          traceId: 'trace-409',
        },
        { status: 409 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPage(['OFFICER'], '/alerts/roster?dispatchId=D-2');

  const select = await screen.findByLabelText(/officer/i);
  await user.selectOptions(select, 'm-1');

  expect(
    await screen.findByText(
      'This seat was changed by another officer. The board has been refreshed.',
    ),
  ).toBeTruthy();
});
