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
import { OccupancyDetailPage } from './OccupancyDetailPage';

// Both editors save whole lists (PUT occupancy hazards, PUT pre-plan), so an editor that opens
// empty silently deletes everything already on file the first time someone adds one item.

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

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(['CHIEF'])}>
        <MemoryRouter initialEntries={['/inspections/occupancies/occ-1']}>
          <Routes>
            <Route
              path="/inspections/occupancies/:id"
              element={
                <RequireRole>
                  <OccupancyDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const OCCUPANCY = {
  occupancyId: 'occ-1',
  address: '9 Elm St',
  occupancyType: 'Residential',
  contacts: [],
  hazards: ['Propane tank', 'Basement storage'],
};

const PRE_PLAN = {
  prePlanId: 'pp-1',
  siteDiagramS3Key: 'nichols-fd/PRE_PLAN/pp-1/site.pdf',
  siteDiagramUrl: 'https://assets.example/site.pdf',
  attachmentS3Keys: ['nichols-fd/PRE_PLAN/pp-1/floor-1.pdf'],
  attachmentUrls: [
    { key: 'nichols-fd/PRE_PLAN/pp-1/floor-1.pdf', url: 'https://assets.example/floor-1.pdf' },
  ],
  utilityShutoffs: [{ utility: 'Gas', location: 'North wall' }],
  hazards: ['Truss roof'],
};

test('the hazards editor opens with the hazards on file, and saving keeps them', async () => {
  let saved: unknown;
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.put('/api/v1/inspections/occupancies/occ-1', async ({ request }) => {
      saved = await request.json();
      return HttpResponse.json({ ...OCCUPANCY, hazards: (saved as { hazards: string[] }).hazards });
    }),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  const editor = screen.getByLabelText('Hazards (one per line)') as HTMLTextAreaElement;
  expect(editor.value).toBe('Propane tank\nBasement storage');

  await user.type(editor, '\nOxygen cylinders');
  await user.click(screen.getByRole('button', { name: 'Save hazards' }));

  await waitFor(() =>
    expect(saved).toEqual({ hazards: ['Propane tank', 'Basement storage', 'Oxygen cylinders'] }),
  );
});

test('the pre-plan editor opens with the shutoffs and hazards on file', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () => HttpResponse.json(PRE_PLAN)),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));

  const form = await screen.findByRole('form', { name: 'Save pre-plan' });
  expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Truss roof');
  expect((screen.getByLabelText('Utility') as HTMLInputElement).value).toBe('Gas');
  expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('North wall');
});

test('saving the pre-plan without new files keeps the diagram and attachments on file', async () => {
  let saved: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () => HttpResponse.json(PRE_PLAN)),
    http.put('/api/v1/inspections/occupancies/occ-1/pre-plan', async ({ request }) => {
      saved = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ prePlanId: 'pp-1', attachmentUploadUrls: [] });
    }),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));
  await screen.findByRole('form', { name: 'Save pre-plan' });
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));

  await waitFor(() => expect(saved).toBeDefined());
  expect(saved).toEqual({
    siteDiagramFilename: 'site.pdf',
    attachmentFilenames: ['floor-1.pdf'],
    utilityShutoffs: [{ utility: 'Gas', location: 'North wall' }],
    hazards: ['Truss roof'],
  });
});

test('attachments are listed by file name, not by storage key', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () => HttpResponse.json(PRE_PLAN)),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));

  expect(await screen.findByRole('link', { name: 'floor-1.pdf' })).toBeTruthy();
  expect(screen.queryByText(/nichols-fd\/PRE_PLAN/)).toBeNull();
});
