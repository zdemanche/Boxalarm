import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { AvailabilityPage, nextSixAm } from './AvailabilityPage';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

function makeManager(sub: string | undefined = 'member-7'): UserManager {
  const user = {
    access_token: 'access-token',
    expired: false,
    profile: { sub, 'cognito:groups': ['MEMBER'] },
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

function renderPage(sub?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(sub)}>
        <MemoryRouter>
          <AvailabilityPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

test('no duration is pre-selected, and submitting without one sends nothing', async () => {
  const posted = vi.fn();
  server.use(
    http.post('/api/v1/personnel/members/:memberId/availability', () => {
      posted();
      return HttpResponse.json({}, { status: 201 });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  const radios = await screen.findAllByRole('radio');
  expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Mark unavailable' }));

  expect((await screen.findByRole('alert')).textContent).toMatch(/Choose how long/);
  expect(posted).not.toHaveBeenCalled();
});

test('a preset posts epoch seconds to the signed-in member and confirms', async () => {
  let body: Record<string, unknown> | undefined;
  let memberId: string | undefined;
  server.use(
    http.post('/api/v1/personnel/members/:memberId/availability', async ({ request, params }) => {
      memberId = params.memberId as string;
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ memberId, affectsAlerting: true, ...body }, { status: 201 });
    }),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('radio', { name: '3 days' }));
  await user.selectOptions(screen.getByLabelText(/Reason/), 'Travel');
  await user.click(screen.getByRole('button', { name: 'Mark unavailable' }));

  expect(await screen.findByText(/marked unavailable until/)).toBeTruthy();
  expect(memberId).toBe('member-7');
  expect((body?.endAt as number) - (body?.startAt as number)).toBe(3 * 24 * 60 * 60);
  expect(body?.reason).toBe('Travel');
});

test('custom dates use labelled date-time pickers', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('radio', { name: 'Custom dates' }));

  expect((screen.getByLabelText('From') as HTMLInputElement).type).toBe('datetime-local');
  expect((screen.getByLabelText('Until') as HTMLInputElement).type).toBe('datetime-local');
});

test('a failed save says plainly that nothing was marked off', async () => {
  server.use(
    http.post('/api/v1/personnel/members/:memberId/availability', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('radio', { name: '24 hours' }));
  await user.click(screen.getByRole('button', { name: 'Mark unavailable' }));

  expect((await screen.findByRole('alert')).textContent).toMatch(/not marked unavailable/);
});

test('tonight ends at the next 06:00', () => {
  expect(nextSixAm(new Date(2026, 8, 29, 23, 0)).getTime()).toBe(
    new Date(2026, 8, 30, 6, 0).getTime(),
  );
});

test('with no member id on the session it asks to sign in again and sends nothing', async () => {
  const posted = vi.fn();
  server.use(
    http.post('/api/v1/personnel/members/:memberId/availability', () => {
      posted();
      return HttpResponse.json({}, { status: 201 });
    }),
  );
  renderPage('');

  expect((await screen.findByRole('alert')).textContent).toMatch(/Sign out and sign back in/);
  expect(screen.queryByRole('button', { name: 'Mark unavailable' })).toBeNull();
  expect(posted).not.toHaveBeenCalled();
});
