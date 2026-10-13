import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

// A failed pre-plan read is not "no pre-plan": an editor offered then would save an empty
// pre-plan over whatever is on file.
test('a failed pre-plan read shows an error and offers no editor to save over it', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't1' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));

  expect(await screen.findByText(/couldn.t load the pre-plan/i)).toBeTruthy();
  expect(screen.queryByText('No pre-plan is on file.')).toBeNull();
  expect(screen.queryByRole('form', { name: 'Save pre-plan' })).toBeNull();
});

test('a new attachment named like the site diagram is refused before it can overwrite it', async () => {
  let putCalled = false;
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () => HttpResponse.json(PRE_PLAN)),
    http.put('/api/v1/inspections/occupancies/occ-1/pre-plan', () => {
      putCalled = true;
      return HttpResponse.json({ prePlanId: 'pp-1', attachmentUploadUrls: [] });
    }),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));
  await screen.findByRole('form', { name: 'Save pre-plan' });
  await user.upload(
    screen.getByLabelText('Attachments'),
    new File(['x'], 'site.pdf', { type: 'application/pdf' }),
  );
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));

  expect(await screen.findByText(/same name as the site diagram/)).toBeTruthy();
  expect(putCalled).toBe(false);
});

test('with no pre-plan yet (404) the editor is offered so the first one can be created', async () => {
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Not Found', status: 404, traceId: 't1' },
        { status: 404 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));

  expect(await screen.findByText('No pre-plan is on file.')).toBeTruthy();
  expect(await screen.findByRole('form', { name: 'Save pre-plan' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

// Removing a file is leaving it out of the next PUT. A remove has to reach the save, and an
// undone one must not; files that stay are still named, or the save drops them too.

const KEY_PREFIX = 'nichols-fd/PRE_PLAN/pp-1/';

type SavedPrePlan = {
  siteDiagramFilename?: string;
  attachmentFilenames: string[];
  utilityShutoffs: unknown[];
  hazards: string[];
};

/** A pre-plan endpoint that stores what is PUT, as the service does, and serves it back. */
function servePrePlan(initial: typeof PRE_PLAN | Record<string, unknown>) {
  let current: Record<string, unknown> = initial;
  const puts: SavedPrePlan[] = [];
  server.use(
    http.get('/api/v1/inspections/occupancies/occ-1', () => HttpResponse.json(OCCUPANCY)),
    http.get('/api/v1/inspections/occupancies/occ-1/pre-plan', () => HttpResponse.json(current)),
    http.put('/api/v1/inspections/occupancies/occ-1/pre-plan', async ({ request }) => {
      const body = (await request.json()) as SavedPrePlan;
      puts.push(body);
      const keys = body.attachmentFilenames.map((name) => `${KEY_PREFIX}${name}`);
      current = {
        prePlanId: 'pp-1',
        siteDiagramS3Key: body.siteDiagramFilename
          ? `${KEY_PREFIX}${body.siteDiagramFilename}`
          : null,
        ...(body.siteDiagramFilename
          ? { siteDiagramUrl: `https://assets.example/${body.siteDiagramFilename}` }
          : {}),
        attachmentS3Keys: keys,
        attachmentUrls: keys.map((key) => ({ key, url: `https://assets.example/${key}` })),
        utilityShutoffs: body.utilityShutoffs,
        hazards: body.hazards,
      };
      return HttpResponse.json({
        prePlanId: 'pp-1',
        attachmentUploadUrls: [],
        utilityShutoffs: body.utilityShutoffs,
        hazards: body.hazards,
      });
    }),
  );
  return puts;
}

async function openPrePlanEditor() {
  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });
  await user.click(screen.getByRole('tab', { name: 'Pre-plan' }));
  await screen.findByRole('form', { name: 'Save pre-plan' });
  return user;
}

test('removing an attachment saves the list without it, only once the removal is confirmed', async () => {
  const puts = servePrePlan(PRE_PLAN);
  const user = await openPrePlanEditor();

  await user.click(screen.getByRole('button', { name: 'Remove attachment floor-1.pdf' }));
  expect(screen.getByText('Removed when you save')).toBeTruthy();
  expect(screen.getByText('floor-1.pdf', { selector: 's' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Remove floor-1.pdf from the 9 Elm St pre-plan?',
  });
  expect(puts).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Remove floor-1.pdf and save' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    siteDiagramFilename: 'site.pdf',
    attachmentFilenames: [],
    utilityShutoffs: [{ utility: 'Gas', location: 'North wall' }],
    hazards: ['Truss roof'],
  });
  // The page shows what the server now holds, with no removal left pending.
  await waitFor(() => expect(screen.queryByRole('link', { name: 'floor-1.pdf' })).toBeNull());
  expect(screen.queryByRole('button', { name: /floor-1\.pdf/ })).toBeNull();
  expect(screen.queryByText('Removed when you save')).toBeNull();
  expect(screen.getByRole('link', { name: 'View diagram' })).toBeTruthy();
});

test('removing the site diagram saves with no site diagram named', async () => {
  const puts = servePrePlan(PRE_PLAN);
  const user = await openPrePlanEditor();

  await user.click(screen.getByRole('button', { name: 'Remove site diagram' }));
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Remove site.pdf from the 9 Elm St pre-plan?',
  });
  await user.click(within(dialog).getByRole('button', { name: 'Remove site.pdf and save' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).not.toHaveProperty('siteDiagramFilename');
  expect(puts[0]?.attachmentFilenames).toEqual(['floor-1.pdf']);
  await waitFor(() => expect(screen.queryByRole('link', { name: 'View diagram' })).toBeNull());
});

test('Undo puts a file back, and the save keeps it without asking', async () => {
  const puts = servePrePlan(PRE_PLAN);
  const user = await openPrePlanEditor();

  await user.click(screen.getByRole('button', { name: 'Remove attachment floor-1.pdf' }));
  await user.click(screen.getByRole('button', { name: 'Undo removing attachment floor-1.pdf' }));
  expect(screen.queryByText('Removed when you save')).toBeNull();
  expect(screen.getByRole('button', { name: 'Remove attachment floor-1.pdf' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(puts[0]).toMatchObject({
    siteDiagramFilename: 'site.pdf',
    attachmentFilenames: ['floor-1.pdf'],
  });
});

test('at the 50-attachment limit, removing one makes room for a new one', async () => {
  const names = Array.from({ length: 50 }, (_, i) => `doc-${i + 1}.pdf`);
  const keys = names.map((name) => `${KEY_PREFIX}${name}`);
  const puts = servePrePlan({
    ...PRE_PLAN,
    attachmentS3Keys: keys,
    attachmentUrls: keys.map((key) => ({ key, url: `https://assets.example/${key}` })),
  });
  const user = await openPrePlanEditor();

  await user.upload(
    screen.getByLabelText('Attachments'),
    new File(['x'], 'new.pdf', { type: 'application/pdf' }),
  );
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  expect(await screen.findByText(/at most 50 attachments; this save would have 51/)).toBeTruthy();
  expect(puts).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: 'Remove attachment doc-1.pdf' }));
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Remove doc-1.pdf from the 9 Elm St pre-plan?',
  });
  await user.click(within(dialog).getByRole('button', { name: 'Remove doc-1.pdf and save' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]?.attachmentFilenames).toEqual([...names.slice(1), 'new.pdf']);
  expect(screen.queryByText(/at most 50 attachments/)).toBeNull();
});

test('a new site diagram named like an attachment that stays is refused; removing it frees the name', async () => {
  const puts = servePrePlan(PRE_PLAN);
  const user = await openPrePlanEditor();

  await user.upload(
    screen.getByLabelText('Site diagram'),
    new File(['x'], 'floor-1.pdf', { type: 'application/pdf' }),
  );
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  expect(await screen.findByText(/same name as an attachment on file/)).toBeTruthy();
  expect(puts).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: 'Remove attachment floor-1.pdf' }));
  await user.click(screen.getByRole('button', { name: 'Save pre-plan' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Remove floor-1.pdf from the 9 Elm St pre-plan?',
  });
  await user.click(within(dialog).getByRole('button', { name: 'Remove floor-1.pdf and save' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toMatchObject({ siteDiagramFilename: 'floor-1.pdf', attachmentFilenames: [] });
});

test('the page links to the occupancy change history by the id audit entries are written with', async () => {
  servePrePlan(PRE_PLAN);
  renderDetail();
  await screen.findByRole('heading', { name: '9 Elm St' });

  expect(screen.getByRole('link', { name: 'Change history' }).getAttribute('href')).toBe(
    '/audit-log?entityType=OCCUPANCY&entityId=occ-1',
  );
});
