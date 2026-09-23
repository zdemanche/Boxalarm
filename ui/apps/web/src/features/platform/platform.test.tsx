import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { MemberDetailPage } from '../personnel/MemberDetailPage';
import type { Member } from '../personnel/types';
import { AuditLogPage } from './AuditLogPage';
import { SettingsPage } from './SettingsPage';
import type { ConfigResponse } from './types';

const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function makeManager(groups: string[]): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub: 'admin-1', 'cognito:groups': groups },
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

function renderRoute(groups: string[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/settings"
              element={
                <RequireRole>
                  <SettingsPage />
                </RequireRole>
              }
            />
            <Route
              path="/audit-log"
              element={
                <RequireRole>
                  <AuditLogPage />
                </RequireRole>
              }
            />
            <Route
              path="/personnel/:id"
              element={
                <RequireRole>
                  <MemberDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('admin edits alert-rule threshold N; a 409 shows the reloaded value', async () => {
  const stored: ConfigResponse = {
    configType: 'ALERT_RULES',
    value: { escalationThresholdN: 60 },
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'someone',
  };
  server.use(
    http.get('/api/v1/platform/config/ALERT_RULES', () => HttpResponse.json(stored)),
    http.get('/api/v1/platform/config/STATIONS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/RANKS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.get('/api/v1/platform/config/CHECKLIST_DEFAULTS', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
    http.put('/api/v1/platform/config/ALERT_RULES', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'department config was modified concurrently; reload and retry',
          traceId: 't2',
        },
        { status: 409 },
      ),
    ),
    http.get('/api/v1/platform/retention', () =>
      HttpResponse.json({ retentionYears: 7, version: 1, source: 'stored' }),
    ),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/settings');
  const textarea = await screen.findByLabelText('Alert rule timing (JSON)');
  expect((textarea as HTMLTextAreaElement).value).toContain('60');

  fireEvent.change(textarea, { target: { value: '{"escalationThresholdN":90}' } });
  await user.click(screen.getByRole('button', { name: 'Save Alert rule timing' }));

  await waitFor(() => {
    expect(
      screen.getByText(
        'This config was updated by someone else. Showing the latest value — review and save again.',
      ),
    ).toBeTruthy();
  });
});

test('audit log lookup renders a readable diff; a 400 shows detail next to the input', async () => {
  server.use(
    http.get('/api/v1/platform/audit', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('entityId') === 'bad id') {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail:
              'entityType and entityId query parameters are required and must not contain "," or "#".',
            traceId: 't1',
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        entries: [
          {
            actorId: 'admin-1',
            ts: Date.parse('2026-01-01T00:00:00.000Z'),
            action: 'UPDATE',
            mutatedEntityType: 'DEPARTMENT_CONFIG',
            mutatedEntityId: 'ALERT_RULES',
            changedFields: { escalationThresholdN: { old: 60, new: 90 } },
          },
        ],
      });
    }),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/audit-log');
  await screen.findByRole('heading', { name: 'Audit log' });

  await user.type(screen.getByLabelText('Entity type'), 'DEPARTMENT_CONFIG');
  await user.type(screen.getByLabelText('Entity ID'), 'ALERT_RULES');
  await user.click(screen.getByRole('button', { name: 'Look up' }));

  await waitFor(() => {
    expect(screen.getByText(/escalationThresholdN: 60 → 90/)).toBeTruthy();
  });
});

test('admin revokes a member’s sessions from /personnel/:id', async () => {
  const member: Member = {
    memberId: 'm1',
    firstName: 'Sam',
    lastName: 'Lee',
    email: 'sam@example.com',
    phone: '203-555-0199',
    status: 'ACTIVE',
    joinDate: '2020-01-01',
    rank: 'Lt',
    agencyId: 'NFD-1',
  };
  server.use(
    http.get('/api/v1/personnel/members/m1', () => HttpResponse.json(member)),
    http.post('/api/v1/platform/sessions/revoke', async ({ request }) => {
      const body = (await request.json()) as { memberId: string };
      return HttpResponse.json({ memberId: body.memberId, status: 'revoked' }, { status: 202 });
    }),
  );

  const user = userEvent.setup();
  renderRoute(['ADMIN'], '/personnel/m1');
  await screen.findByRole('heading', { name: 'Sam Lee' });
  await user.click(screen.getByRole('button', { name: 'Revoke all sessions (lost device)' }));

  await waitFor(() => {
    expect(screen.getByText('Sessions revoked.')).toBeTruthy();
  });
});
