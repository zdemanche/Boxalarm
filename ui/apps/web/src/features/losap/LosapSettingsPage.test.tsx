import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { LosapSettingsPage } from './LosapSettingsPage';

const server = setupServer();
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
    profile: { sub: 'admin-1', 'cognito:groups': ['ADMIN'] },
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
      <AuthProvider userManager={makeManager()}>
        <MemoryRouter>
          <LosapSettingsPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const currentRules = {
  configType: 'LOSAP_POINT_RULES',
  version: 3,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin-1',
  value: {
    ruleVersionId: 'rv-1',
    pointsByActivityType: { CALL: 1, DRILL: 2, MEETING: 1, WORK_DETAIL: 1, STANDBY: 1 },
  },
};

test('existing rules are prefilled and saving one change keeps the others', async () => {
  let putBody: { pointsByActivityType: Record<string, number> } | undefined;
  server.use(
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () => HttpResponse.json(currentRules)),
    http.put('/api/v1/personnel/losap/rules', async ({ request }) => {
      putBody = (await request.json()) as typeof putBody;
      return HttpResponse.json({ ruleVersionId: 'rv-2', ...putBody });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  const drill = (await screen.findByLabelText('Drill points')) as HTMLInputElement;
  await vi.waitFor(() => expect(drill.value).toBe('2'));
  expect((screen.getByLabelText('Call points') as HTMLInputElement).value).toBe('1');

  await user.clear(drill);
  await user.type(drill, '3');
  await user.click(screen.getByRole('button', { name: 'Save rules' }));

  await screen.findByText(/Saved as rule version rv-2/);
  expect(putBody?.pointsByActivityType).toEqual({
    CALL: 1,
    DRILL: 3,
    MEETING: 1,
    WORK_DETAIL: 1,
    STANDBY: 1,
  });
});

test('no rules yet (404) leaves the fields blank and editable', async () => {
  server.use(
    http.get('/api/v1/platform/config/LOSAP_POINT_RULES', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't' },
        { status: 404 },
      ),
    ),
  );
  renderPage();

  const drill = (await screen.findByLabelText('Drill points')) as HTMLInputElement;
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save rules' }).getAttribute('aria-busy')).toBeNull(),
  );
  expect(drill.value).toBe('');
});
