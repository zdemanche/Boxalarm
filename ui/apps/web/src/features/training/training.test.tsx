import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { RequireRole } from '../../routing/RequireRole';
import { CertificationsPage } from './CertificationsPage';
import { safeAttachmentFilename } from './api';
import { CertificationsPanel } from './CertificationsPanel';
import { TrainingEventsPage } from './TrainingEventsPage';
import { TrainingHoursPage } from './TrainingHoursPage';
import { TranscriptPanel } from './TranscriptPanel';
import type { Certification, TrainingEvent } from './types';

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
    profile: { sub: 'training-1', 'cognito:groups': groups },
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

function renderPage(element: React.ReactElement, groups: string[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={<RequireRole>{element}</RequireRole>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderPanel(element: React.ReactElement, groups: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>{element}</AuthProvider>
    </QueryClientProvider>,
  );
}

test('training officer sees the expiring tab sorted by expiry date', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () =>
      HttpResponse.json([
        {
          certId: 'CERT-2',
          memberId: 'm-2',
          certType: 'Hazmat',
          expiryDate: '2026-02-01',
          issuingAuthority: 'CT DESPP',
          status: 'CURRENT',
        },
        {
          certId: 'CERT-1',
          memberId: 'm-1',
          certType: 'FF1',
          expiryDate: '2026-01-01',
          issuingAuthority: 'CT DESPP',
          status: 'CURRENT',
        },
      ]),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  await screen.findByRole('heading', { name: 'Certifications' });
  await user.click(screen.getByRole('tab', { name: 'Expiring' }));

  const rows = await screen.findAllByRole('row');
  expect(rows[1]?.textContent).toContain('FF1');
  expect(rows[2]?.textContent).toContain('Hazmat');
});

test('expiring tab renders an empty state instead of an error when none are due', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () => HttpResponse.json([])),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  await screen.findByRole('heading', { name: 'Certifications' });
  await user.click(screen.getByRole('tab', { name: 'Expiring' }));

  expect(
    await screen.findByText('No certifications are due to expire within the configured window.'),
  ).toBeTruthy();
});

test('training officer creates an event and it appears in start order; a member can sign up', async () => {
  // Upcoming: an event that has already started offers no sign-up.
  let events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2099-06-01T18:00:00Z'),
      endAt: Date.parse('2099-06-01T20:00:00Z'),
      signedUp: false,
    },
  ];

  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events', async ({ request }) => {
      const body = (await request.json()) as Omit<TrainingEvent, 'eventId' | 'signedUp'>;
      const created: TrainingEvent = { ...body, eventId: 'evt-2', signedUp: false };
      events = [...events, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post('/api/v1/training/events/:eventId/signup', ({ params }) => {
      events = events.map((e) => (e.eventId === params.eventId ? { ...e, signedUp: true } : e));
      return HttpResponse.json({ eventId: params.eventId }, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  await user.type(screen.getByLabelText('Title'), 'Hose drill');
  await user.type(screen.getByLabelText('Category'), 'Hose');
  await user.type(screen.getByLabelText('Starts'), '2099-07-01T09:00');
  await user.type(screen.getByLabelText('Ends'), '2099-07-01T11:00');
  await user.click(screen.getByRole('button', { name: 'Create event' }));
  await screen.findByText('Hose drill');
  // M9: the date inputs are controlled, so a reset form really is empty and the next create
  // can't pass `required` while posting startAt/endAt = 0.
  await waitFor(() => {
    expect((screen.getByLabelText('Starts') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Ends') as HTMLInputElement).value).toBe('');
  });

  const signUpButtons = screen.getAllByRole('button', { name: 'Sign up' });
  await user.click(signUpButtons[0]!);

  await waitFor(() => {
    expect(screen.getByText(/Signed up/)).toBeTruthy();
  });
});

test('training officer records post-event hours for an attendee via the hours form', async () => {
  const events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2020-01-01T18:00:00Z'),
      endAt: Date.parse('2020-01-01T20:00:00Z'),
      signedUp: false,
    },
  ];

  let recordedBody: unknown;
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'm-1', firstName: 'Alex', lastName: 'Rivera', status: 'ACTIVE' }],
      }),
    ),
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events/:eventId/signup', async ({ request }) => {
      const body = (await request.json().catch(() => undefined)) as
        { attendees?: unknown } | undefined;
      if (body?.attendees !== undefined) {
        recordedBody = body;
        return HttpResponse.json({ eventId: 'evt-1', attendeeCount: 1 });
      }
      return HttpResponse.json({ eventId: 'evt-1' }, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  const form = screen.getByRole('form', { name: 'Record hours for Ladder drill' });
  await within(form).findByRole('option', { name: 'Rivera, Alex' });
  await user.selectOptions(within(form).getByLabelText('Member'), 'm-1');
  await user.type(within(form).getByLabelText('Hours'), '2');
  await user.click(within(form).getByRole('button', { name: 'Record hours' }));

  await waitFor(() => {
    expect(recordedBody).toEqual({ attendees: [{ memberId: 'm-1', hours: 2 }] });
  });
  await waitFor(() => {
    expect((within(form).getByLabelText('Member') as HTMLSelectElement).value).toBe('');
  });
});

test('training officer adds a certification and can revoke it; a non-training role has no controls', async () => {
  let certifications: Certification[] = [];

  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () =>
      HttpResponse.json(certifications),
    ),
    http.post('/api/v1/training/members/m-1/certifications', async ({ request }) => {
      const body = (await request.json()) as Omit<
        Certification,
        'certId' | 'memberId' | 'status' | 'attachmentS3Key'
      >;
      const created: Certification = {
        ...body,
        certId: 'CERT-1',
        memberId: 'm-1',
        attachmentS3Key: null,
        status: 'CURRENT',
      };
      certifications = [...certifications, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post('/api/v1/training/members/m-1/certifications/CERT-1/revoke', () => {
      certifications = certifications.map((c) =>
        c.certId === 'CERT-1' ? { ...c, status: 'REVOKED' } : c,
      );
      return HttpResponse.json(certifications[0]);
    }),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await screen.findByRole('heading', { name: 'Certifications' });

  await user.type(screen.getByLabelText('Certification type'), 'FF1');
  await user.type(screen.getByLabelText('Issue date'), '2024-01-01');
  await user.type(screen.getByLabelText('Expiry date'), '2029-01-01');
  await user.type(screen.getByLabelText('Issuing authority'), 'CT DESPP');
  await user.click(screen.getByRole('button', { name: 'Add certification' }));

  const certRow = (await screen.findByText('FF1')).closest('li')!;
  // A volunteer reads the expiry as a date, not the ISO string the API sends.
  expect(certRow.textContent).toMatch(/expires .*2029/);
  expect(certRow.textContent).not.toContain('2029-01-01');
  await user.click(screen.getByRole('button', { name: 'Revoke' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revoke FF1?' });
  await user.click(within(dialog).getByRole('button', { name: 'Revoke certification' }));

  await waitFor(() => {
    expect(screen.getByText(/Revoked/)).toBeTruthy();
  });

  cleanup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['OFFICER']);
  await screen.findByText(/FF1/);
  expect(screen.queryByRole('form', { name: 'Add certification' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});

test('a failed revoke stays in the confirm dialog and shows the error (m2)', async () => {
  const cert: Certification = {
    certId: 'CERT-1',
    memberId: 'm-1',
    certType: 'FF1',
    issueDate: '2024-01-01',
    expiryDate: '2029-01-01',
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status: 'CURRENT',
  };
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () => HttpResponse.json([cert])),
    http.post('/api/v1/training/members/m-1/certifications/CERT-1/revoke', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await user.click(await screen.findByRole('button', { name: 'Revoke' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revoke FF1?' });
  await user.click(within(dialog).getByRole('button', { name: 'Revoke certification' }));

  expect(await within(dialog).findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Revoke FF1?' })).toBeTruthy();
});

test('failed sign-up and failed hours recording are shown, not swallowed (m2)', async () => {
  const events: TrainingEvent[] = [
    {
      eventId: 'evt-1',
      title: 'Ladder drill',
      category: 'Ladders',
      startAt: Date.parse('2020-01-01T18:00:00Z'),
      endAt: Date.parse('2020-01-01T20:00:00Z'),
      signedUp: false,
    },
    {
      eventId: 'evt-2',
      title: 'Hose drill',
      category: 'Hose',
      startAt: Date.parse('2099-01-01T18:00:00Z'),
      endAt: Date.parse('2099-01-01T20:00:00Z'),
      signedUp: false,
    },
  ];
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'm-1', firstName: 'Alex', lastName: 'Rivera', status: 'ACTIVE' }],
      }),
    ),
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events/:eventId/signup', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
        { status: 503 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');

  await user.click(screen.getByRole('button', { name: 'Sign up' }));
  expect(await screen.findByText(/Sign-up failed/)).toBeTruthy();

  const form = screen.getByRole('form', { name: 'Record hours for Ladder drill' });
  await within(form).findByRole('option', { name: 'Rivera, Alex' });
  await user.selectOptions(within(form).getByLabelText('Member'), 'm-1');
  await user.type(within(form).getByLabelText('Hours'), '2');
  await user.click(within(form).getByRole('button', { name: 'Record hours' }));
  expect(await within(form).findByText(/Hours not recorded/)).toBeTruthy();
});

test('a started event offers no sign-up and says why; only the clicked row shows pending', async () => {
  const event = (eventId: string, title: string, start: string, end: string): TrainingEvent => ({
    eventId,
    title,
    category: 'Drill',
    startAt: Date.parse(start),
    endAt: Date.parse(end),
    signedUp: false,
  });
  const now = Date.now();
  const events: TrainingEvent[] = [
    event('evt-past', 'Ladder drill', '2020-01-01T18:00:00Z', '2020-01-01T20:00:00Z'),
    {
      ...event('evt-now', 'Live burn', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
      startAt: now - 3_600_000,
      endAt: now + 3_600_000,
    },
    event('evt-a', 'Hose drill', '2099-01-01T18:00:00Z', '2099-01-01T20:00:00Z'),
    event('evt-b', 'Pump drill', '2099-02-01T18:00:00Z', '2099-02-01T20:00:00Z'),
  ];
  let requested = false;
  let release: () => void = () => undefined;
  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json(events)),
    http.post('/api/v1/training/events/:eventId/signup', async () => {
      requested = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json({ eventId: 'evt-a' }, { status: 201 });
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  const pastRow = (await screen.findByText('Ladder drill')).closest('li')!;
  expect(within(pastRow).queryByRole('button', { name: 'Sign up' })).toBeNull();
  expect(pastRow.textContent).toContain('Sign-up closed: the event is over');
  const runningRow = screen.getByText('Live burn').closest('li')!;
  expect(within(runningRow).queryByRole('button', { name: 'Sign up' })).toBeNull();
  expect(runningRow.textContent).toContain('Sign-up closed: the event has started');

  const [hose, pump] = screen.getAllByRole('button', { name: 'Sign up' });
  expect(screen.getByText('Hose drill').closest('li')!.contains(hose!)).toBe(true);
  await user.click(hose!);
  await waitFor(() => expect(requested).toBe(true));
  expect(hose!.getAttribute('aria-busy')).toBe('true');
  expect(pump!.getAttribute('aria-busy')).toBeNull();
  release();
});

test('a failed transcript export is reported instead of an unhandled rejection (m2)', async () => {
  server.use(
    http.get('/api/v1/training/members/m-1/transcript', ({ request }) => {
      if (new URL(request.url).searchParams.get('format')) {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't' },
          { status: 503 },
        );
      }
      return HttpResponse.json({
        memberId: 'm-1',
        certifications: [],
        attendance: [],
        hoursByCategory: {},
      });
    }),
  );

  const user = userEvent.setup();
  renderPanel(<TranscriptPanel memberId="m-1" />, ['TRAINING']);
  await user.click(await screen.findByRole('button', { name: 'Export CSV' }));

  expect(await screen.findByText('The CSV export failed. Try again.')).toBeTruthy();
});

test('certifications views are a full tabs pattern: tabpanel, aria-controls, arrow keys (m7)', async () => {
  server.use(
    http.get('/api/v1/training/certifications/expiring', () => HttpResponse.json([])),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  const user = userEvent.setup();
  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  const expiringTab = await screen.findByRole('tab', { name: 'Expiring' });
  const panel = screen.getByRole('tabpanel');
  expect(expiringTab.getAttribute('aria-controls')).toBe(panel.id);

  expiringTab.focus();
  await user.keyboard('{ArrowRight}');
  const byMemberTab = screen.getByRole('tab', { name: 'By member' });
  expect(document.activeElement).toBe(byMemberTab);
  expect(byMemberTab.getAttribute('aria-selected')).toBe('true');
});

test('training hours: roster hours by member and category, named from the roster, year to date', async () => {
  let params: URLSearchParams | undefined;
  server.use(
    http.get('/api/v1/training/hours', ({ request }) => {
      params = new URL(request.url).searchParams;
      return HttpResponse.json({
        from: Number(params.get('from')),
        to: Number(params.get('to')),
        members: [
          {
            memberId: 'm-1',
            categories: [
              { category: 'Ladders', hours: 6 },
              { category: 'Hazmat', hours: 2.5 },
            ],
          },
          { memberId: 'm-9', categories: [{ category: 'Ladders', hours: 3 }] },
        ],
      });
    }),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'm-1', firstName: 'Alex', lastName: 'Rivera', status: 'ACTIVE' }],
      }),
    ),
  );

  renderPage(<TrainingHoursPage />, ['TRAINING'], '/training/hours');

  const table = await screen.findByRole('table');
  const rivera = await within(table).findByRole('rowheader', { name: 'Alex Rivera' });
  const riveraRow = rivera.closest('tr')!;
  expect(
    within(riveraRow)
      .getAllByRole('cell')
      .map((c) => c.textContent),
  ).toEqual(['2.5', '6', '8.5']);
  const unknownRow = within(table).getByRole('rowheader', { name: 'm-9' }).closest('tr')!;
  expect(
    within(unknownRow)
      .getAllByRole('cell')
      .map((c) => c.textContent),
  ).toEqual(['0', '3', '3']);
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['Member', 'Hazmat', 'Ladders', 'Total hours']);

  const now = new Date();
  expect(Number(params?.get('from'))).toBe(new Date(now.getFullYear(), 0, 1).getTime());
  const endOfToday =
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 86_400_000 - 1;
  expect(Number(params?.get('to'))).toBe(endOfToday);
});

test('training hours: an empty range says no hours were recorded for it', async () => {
  server.use(
    http.get('/api/v1/training/hours', () => HttpResponse.json({ from: 0, to: 0, members: [] })),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<TrainingHoursPage />, ['OFFICER'], '/training/hours');

  expect(
    await screen.findByText(/No training hours were recorded for events between/),
  ).toBeTruthy();
});

test('training hours: a 403 renders the forbidden state, not an empty table', async () => {
  server.use(
    http.get('/api/v1/training/hours', () =>
      HttpResponse.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' },
        { status: 403 },
      ),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<TrainingHoursPage />, ['CHIEF'], '/training/hours');

  expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  expect(screen.queryByText(/No training hours were recorded/)).toBeNull();
});

test('training hours: a reversed range is rejected before any request', async () => {
  let requested = 0;
  server.use(
    http.get('/api/v1/training/hours', () => {
      requested += 1;
      return HttpResponse.json({ from: 0, to: 0, members: [] });
    }),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<TrainingHoursPage />, ['TRAINING'], '/training/hours');
  await screen.findByRole('table');
  const before = requested;

  const from = screen.getByLabelText('From');
  fireEvent.change(from, { target: { value: '2999-01-01' } });

  expect(await screen.findByText('Choose a start date on or before the end date.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(requested).toBe(before);
});

test('training hours: MEMBER is not granted the page', async () => {
  renderPage(<TrainingHoursPage />, ['MEMBER'], '/training/hours');
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Training hours' })).toBeNull());
});

// design.md O-11: the page opens on the department's certifications soonest-expiring first. It
// used to open on a lone "Select a member…" picker, with the expiring list one tab over showing
// member ids and ISO dates.
test('certifications open on the expiring list, named from the roster, with a status', async () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  const soonIso = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  server.use(
    http.get('/api/v1/training/certifications/expiring', () =>
      HttpResponse.json([
        {
          certId: 'c-1',
          memberId: 'm-2',
          certType: 'EVOC',
          expiryDate: soonIso,
          issuingAuthority: 'CT',
          status: 'CURRENT',
        },
      ]),
    ),
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [{ memberId: 'm-2', firstName: 'Jordan', lastName: 'Osei', status: 'ACTIVE' }],
      }),
    ),
  );

  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  const expiringTab = await screen.findByRole('tab', { name: 'Expiring' });
  expect(expiringTab.getAttribute('aria-selected')).toBe('true');
  const row = (await screen.findByText('Jordan Osei')).closest('tr')!;
  expect(row.textContent).toContain('EVOC');
  expect(row.textContent).not.toContain(soonIso);
  expect(row.textContent).toContain('Expires in 10 days');
});

const BAD_REQUEST = (detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Bad Request', status: 400, detail, traceId: 't' },
    { status: 400 },
  );

async function fillCertification(user: ReturnType<typeof userEvent.setup>, expiry = '2029-01-01') {
  await user.type(screen.getByLabelText('Certification type'), 'FF1');
  await user.type(screen.getByLabelText('Issue date'), '2024-01-01');
  await user.type(screen.getByLabelText('Expiry date'), expiry);
  await user.type(screen.getByLabelText('Issuing authority'), 'CT DESPP');
}

test('certification attachment filename is cleaned to what the API accepts before it is sent', async () => {
  let body: { attachment?: { filename: string } } | undefined;
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () => HttpResponse.json([])),
    http.post('/api/v1/training/members/m-1/certifications', async ({ request }) => {
      body = (await request.json()) as typeof body;
      return HttpResponse.json(
        {
          certId: 'CERT-1',
          memberId: 'm-1',
          certType: 'FF1',
          issueDate: '2024-01-01',
          expiryDate: '2029-01-01',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: 'd/CERTIFICATION/CERT-1/FF1_Card.pdf',
          status: 'CURRENT',
        },
        { status: 201 },
      );
    }),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await screen.findByRole('heading', { name: 'Certifications' });
  await fillCertification(user);
  await user.upload(
    screen.getByLabelText('Attachment (optional)'),
    new File(['x'], '(FF1 Card).pdf', { type: 'application/pdf' }),
  );
  await user.click(screen.getByRole('button', { name: 'Add certification' }));

  await waitFor(() => expect(body?.attachment?.filename).toBe('FF1_Card_.pdf'));
});

test('an attachment name with no usable stem keeps its extension', () => {
  expect(safeAttachmentFilename('Сертификат.pdf')).toBe('attachment.pdf');
  expect(safeAttachmentFilename('(FF1 Card).pdf')).toBe('FF1_Card_.pdf');
});

test('recording hours refreshes sibling training queries, and the member picker is sorted without retired members', async () => {
  let eventGets = 0;
  server.use(
    http.get('/api/v1/personnel/members', () =>
      HttpResponse.json({
        items: [
          { memberId: 'm-2', firstName: 'Zed', lastName: 'Zane', status: 'ACTIVE' },
          { memberId: 'm-1', firstName: 'Amy', lastName: 'Adams', status: 'ACTIVE' },
          { memberId: 'm-3', firstName: 'Old', lastName: 'Timer', status: 'RETIRED' },
        ],
      }),
    ),
    http.get('/api/v1/training/events', () => {
      eventGets += 1;
      return HttpResponse.json([
        {
          eventId: 'evt-1',
          title: 'Ladder drill',
          category: 'Ladders',
          startAt: Date.parse('2020-01-01T18:00:00Z'),
          endAt: Date.parse('2020-01-01T20:00:00Z'),
          signedUp: false,
        },
      ]);
    }),
    http.post('/api/v1/training/events/:eventId/signup', () =>
      HttpResponse.json({ eventId: 'evt-1', attendeeCount: 1 }),
    ),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('Ladder drill');
  const form = screen.getByRole('form', { name: 'Record hours for Ladder drill' });
  await within(form).findByRole('option', { name: 'Adams, Amy' });
  expect(
    within(form)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Select a member…', 'Adams, Amy', 'Zane, Zed']);
  const before = eventGets;
  await user.selectOptions(within(form).getByLabelText('Member'), 'm-1');
  await user.type(within(form).getByLabelText('Hours'), '2');
  await user.click(within(form).getByRole('button', { name: 'Record hours' }));
  await waitFor(() => expect(eventGets).toBeGreaterThan(before));
});

test('a certification create 400 shows its detail, and a reversed expiry is not sent', async () => {
  let posts = 0;
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () => HttpResponse.json([])),
    http.post('/api/v1/training/members/m-1/certifications', () => {
      posts += 1;
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The request failed validation.',
          traceId: 't',
          errors: [{ field: 'attachment.filename', detail: 'must have an allowed extension' }],
        },
        { status: 400 },
      );
    }),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await screen.findByRole('heading', { name: 'Certifications' });
  await fillCertification(user, '2020-01-01');
  await user.click(screen.getByRole('button', { name: 'Add certification' }));
  expect(await screen.findByText(/Expiry date can't be before the issue date/)).toBeTruthy();
  expect(posts).toBe(0);

  await user.clear(screen.getByLabelText('Expiry date'));
  await user.type(screen.getByLabelText('Expiry date'), '2029-01-01');
  await user.click(screen.getByRole('button', { name: 'Add certification' }));
  expect(
    await screen.findByText('attachment.filename: must have an allowed extension'),
  ).toBeTruthy();
  expect(screen.queryByText("Expiry date can't be before the issue date.")).toBeNull();
});

test('the attachment input is cleared after a create so the next certification is not silently attachment-less', async () => {
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () => HttpResponse.json([])),
    http.post('/api/v1/training/members/m-1/certifications', () =>
      HttpResponse.json(
        {
          certId: 'CERT-1',
          memberId: 'm-1',
          certType: 'FF1',
          issueDate: '2024-01-01',
          expiryDate: '2029-01-01',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
        { status: 201 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderPanel(<CertificationsPanel memberId="m-1" />, ['TRAINING']);
  await screen.findByRole('heading', { name: 'Certifications' });
  await fillCertification(user);
  const input = screen.getByLabelText('Attachment (optional)') as HTMLInputElement;
  await user.upload(input, new File(['x'], 'certs.pdf', { type: 'application/pdf' }));
  expect(input.files).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Add certification' }));

  await waitFor(() => expect(input.files).toHaveLength(0));
});

test('revoking a certification refreshes the transcript on the same page', async () => {
  let revoked = false;
  let transcriptGets = 0;
  const cert = (status: string) => ({
    certId: 'CERT-1',
    memberId: 'm-1',
    certType: 'FF1',
    issueDate: '2024-01-01',
    expiryDate: '2029-01-01',
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status,
  });
  server.use(
    http.get('/api/v1/training/members/m-1/certifications', () =>
      HttpResponse.json([cert(revoked ? 'REVOKED' : 'CURRENT')]),
    ),
    http.get('/api/v1/training/members/m-1/transcript', () => {
      transcriptGets += 1;
      return HttpResponse.json({
        memberId: 'm-1',
        certifications: [],
        attendance: [],
        hoursByCategory: {},
      });
    }),
    http.post('/api/v1/training/members/m-1/certifications/CERT-1/revoke', () => {
      revoked = true;
      return HttpResponse.json(cert('REVOKED'));
    }),
  );

  const user = userEvent.setup();
  renderPanel(
    <>
      <CertificationsPanel memberId="m-1" />
      <TranscriptPanel memberId="m-1" />
    </>,
    ['TRAINING'],
  );
  await user.click(await screen.findByRole('button', { name: 'Revoke' }));
  const dialog = await screen.findByRole('dialog', { name: 'Revoke FF1?' });
  await waitFor(() => expect(transcriptGets).toBeGreaterThan(0));
  const before = transcriptGets;
  await user.click(within(dialog).getByRole('button', { name: 'Revoke certification' }));

  await waitFor(() => expect(transcriptGets).toBeGreaterThan(before));
});

test('the expiring list shows a revoked certification as revoked, not as expiring soon', async () => {
  const soon = new Date();
  soon.setDate(soon.getDate() + 12);
  const pad = (n: number) => String(n).padStart(2, '0');
  const soonIso = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
  server.use(
    http.get('/api/v1/training/certifications/expiring', () =>
      HttpResponse.json([
        {
          certId: 'c-1',
          memberId: 'm-2',
          certType: 'EVOC',
          expiryDate: soonIso,
          issuingAuthority: 'CT',
          status: 'REVOKED',
        },
      ]),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<CertificationsPage />, ['TRAINING'], '/certifications');
  const row = (await screen.findByText('EVOC')).closest('tr')!;
  expect(row.textContent).toContain('Revoked');
  expect(row.textContent).not.toContain('Expires in');
});

test('training hours: members who only signed up (zero hours) are not counted or listed', async () => {
  server.use(
    http.get('/api/v1/training/hours', () =>
      HttpResponse.json({
        from: 0,
        to: 0,
        members: [
          { memberId: 'm-1', categories: [{ category: 'Ladders', hours: 2 }] },
          { memberId: 'm-2', categories: [{ category: 'Hose', hours: 0 }] },
        ],
      }),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<TrainingHoursPage />, ['TRAINING'], '/training/hours');
  const table = await screen.findByRole('table');
  await within(table).findByRole('rowheader', { name: 'm-1' });
  expect(within(table).queryByRole('rowheader', { name: 'm-2' })).toBeNull();
  expect(within(table).queryByRole('columnheader', { name: 'Hose' })).toBeNull();
  expect(
    screen.getByText('Members with hours').parentElement?.parentElement?.textContent,
  ).toContain('1');
});

test('training hours: a range holding only zero-hour sign-ups shows the empty state', async () => {
  server.use(
    http.get('/api/v1/training/hours', () =>
      HttpResponse.json({
        from: 0,
        to: 0,
        members: [{ memberId: 'm-2', categories: [{ category: 'Hose', hours: 0 }] }],
      }),
    ),
    http.get('/api/v1/personnel/members', () => HttpResponse.json({ items: [] })),
  );

  renderPage(<TrainingHoursPage />, ['TRAINING'], '/training/hours');
  expect(await screen.findByText(/No training hours were recorded/)).toBeTruthy();
});

test('a reversed event window is rejected before any request; a 400 shows its detail', async () => {
  let posts = 0;
  server.use(
    http.get('/api/v1/training/events', () => HttpResponse.json([])),
    http.post('/api/v1/training/events', () => {
      posts += 1;
      return BAD_REQUEST('title is too long');
    }),
  );

  const user = userEvent.setup();
  renderPage(<TrainingEventsPage />, ['TRAINING'], '/training/events');
  await screen.findByText('No training events scheduled.');

  await user.type(screen.getByLabelText('Title'), 'Hose drill');
  await user.type(screen.getByLabelText('Category'), 'Hose');
  await user.type(screen.getByLabelText('Starts'), '2099-07-01T11:00');
  await user.type(screen.getByLabelText('Ends'), '2099-07-01T09:00');
  await user.click(screen.getByRole('button', { name: 'Create event' }));
  expect(await screen.findByText('End time must be after the start time.')).toBeTruthy();
  expect(posts).toBe(0);

  await user.clear(screen.getByLabelText('Ends'));
  await user.type(screen.getByLabelText('Ends'), '2099-07-01T13:00');
  await user.click(screen.getByRole('button', { name: 'Create event' }));
  expect(await screen.findByText('title is too long')).toBeTruthy();
});
