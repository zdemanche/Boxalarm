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
import { dateTimeLocalToEpoch } from './format';
import { IncidentDetailPage } from './IncidentDetailPage';
import { IncidentsListPage } from './IncidentsListPage';
import type { IncidentDetail, SubmissionState, ValidationReport } from './types';

/** Nothing blocking: the review checklist runs on every detail load. */
function cleanReport(mode = 'local'): ValidationReport {
  return {
    incidentId: 'i-1',
    mode: mode as ValidationReport['mode'],
    blocking: [],
    warnings: [],
    nerisValidatedAt: null,
    sectionsComplete: { core: true, dispatch: true, units: true, narrative: true },
  };
}

/** A few NERIS TypeIncidentValues, as GET /incidents/neris-schema serves them. */
const NERIS_SCHEMA = {
  version: '2026.2+neris-1.5.1',
  apiVersion: '1.5.1',
  incidentTypes: [
    { value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', label: 'Fire › Structure fire › Chimney fire' },
    {
      value: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
      label: 'Fire › Structure fire › Room and contents fire',
    },
    {
      value: 'MEDICAL||ILLNESS||BREATHING_PROBLEMS',
      label: 'Medical › Illness › Breathing problems',
    },
    { value: 'NOEMERG||CANCELLED', label: 'Noemerg › Cancelled' },
  ],
  modules: {},
};

const server = setupServer(
  http.post('/api/v1/incidents/:incidentId/validate', () => HttpResponse.json(cleanReport())),
  http.get('/api/v1/incidents/neris-schema', () => HttpResponse.json(NERIS_SCHEMA)),
);
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

function renderIncidents(groups: string[], path = '/incidents') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager(groups)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/incidents"
              element={
                <RequireRole>
                  <IncidentsListPage />
                </RequireRole>
              }
            />
            <Route
              path="/incidents/:id"
              element={
                <RequireRole>
                  <IncidentDetailPage />
                </RequireRole>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function detail(overrides: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    incidentId: 'i-1',
    deptId: 'nichols-fd',
    dispatchNumber: '26-001841',
    epochSeconds: 1_700_000_000,
    nerisSchemaVersion: '2026.2',
    corePayload: {
      incident_type: 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
      address: '14 Elm St, Trumbull, CT',
    },
    incidentType: 'Structure fire',
    address: '14 Elm St, Trumbull, CT',
    alarmAt: 1_700_000_000,
    dispatchAt: 1_700_000_030,
    narrative: 'Working fire, first floor kitchen.',
    status: 'DRAFT',
    sourceDispatchId: 'd-100',
    createdBy: 'm-1',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    secondaryModules: [],
    respondingUnits: [
      {
        incidentId: 'i-1',
        unitId: 'Engine 301',
        unitType: 'APPARATUS',
        dispatchedAt: 1_700_000_030,
        enRouteAt: 1_700_000_090,
        assignedPositions: ['Officer'],
      },
      {
        incidentId: 'i-1',
        unitId: 'Truck 304',
        unitType: 'APPARATUS',
        dispatchedAt: 1_700_000_045,
        assignedPositions: ['Driver'],
      },
    ],
    respondingMembers: [
      { memberId: 'm-rivera', status: 'RESPONDING' },
      { memberId: 'm-chen', status: 'RESPONDING' },
    ],
    ...overrides,
  };
}

test('date range lists only in-range incidents, ordered by alarm time', async () => {
  const now = Math.floor(Date.now() / 1000);
  const recent = detail({
    incidentId: 'recent',
    dispatchNumber: '26-009000',
    alarmAt: now - 5 * 86400,
    address: '2 New Rd',
    incidentType: 'Alarm',
    status: 'ACCEPTED',
  });
  const older = detail({
    incidentId: 'older',
    dispatchNumber: '26-000100',
    alarmAt: now - 200 * 86400,
    address: '1 Old Rd',
    incidentType: 'Structure fire',
    status: 'DRAFT',
  });
  server.use(
    http.get('/api/v1/incidents', ({ request }) => {
      const url = new URL(request.url);
      const from = Number(url.searchParams.get('fromAlarmAt'));
      const to = Number(url.searchParams.get('toAlarmAt'));
      const incidents = [recent, older]
        .filter((incident) => (incident.alarmAt ?? 0) >= from && (incident.alarmAt ?? 0) <= to)
        .sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0));
      return HttpResponse.json({ incidents });
    }),
  );

  renderIncidents(['OFFICER']);
  expect(await screen.findByRole('rowheader', { name: '26-009000' })).toBeTruthy();
  expect(screen.queryByRole('rowheader', { name: '26-000100' })).toBeNull();

  fireEvent.change(screen.getByLabelText('From'), {
    target: { value: new Date((now - 400 * 86400) * 1000).toISOString().slice(0, 10) },
  });

  await waitFor(() => {
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      '26-000100',
      '26-009000',
    ]);
  });
});

test('detail loads the record, including core payload, from one request', async () => {
  let detailGets = 0;
  server.use(
    http.get('/api/v1/incidents', () =>
      HttpResponse.json({
        incidents: [detail({ alarmAt: Math.floor(Date.now() / 1000) - 86400 })],
      }),
    ),
    http.get('/api/v1/incidents/i-1', () => {
      detailGets += 1;
      return HttpResponse.json(detail());
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER']);
  await screen.findByRole('rowheader', { name: '26-001841' });
  expect(detailGets).toBe(0);
  expect(screen.getByRole('cell', { name: 'Structure fire' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: '14 Elm St, Trumbull, CT' })).toBeTruthy();
  expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);

  await user.click(screen.getAllByRole('link', { name: '26-001841' })[0]!);
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));
  expect(await screen.findByLabelText('NERIS incident type')).toHaveProperty(
    'value',
    'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE',
  );
  expect(detailGets).toBe(1);
});

test('chief creates a report from a dispatch and sees the prefilled fields', async () => {
  const created = detail({
    incidentId: 'i-new',
    dispatchNumber: '26-002100',
    incidentType: 'Structure fire',
    address: '212 Church Hill Rd, Trumbull, CT',
    narrative: 'Smoke showing on arrival, Engine 301 first-due, Truck 304 laddered the rear.',
    respondingUnits: [
      {
        incidentId: 'i-new',
        unitId: 'Engine 301',
        unitType: 'APPARATUS',
        dispatchedAt: 1_700_000_030,
        assignedPositions: ['Officer'],
      },
      {
        incidentId: 'i-new',
        unitId: 'Truck 304',
        unitType: 'APPARATUS',
        dispatchedAt: 1_700_000_045,
        assignedPositions: ['Driver'],
      },
    ],
  });
  server.use(
    http.get('/api/v1/incidents', () => HttpResponse.json({ incidents: [] })),
    http.post('/api/v1/incidents', async ({ request }) => {
      const body = (await request.json()) as { dispatchId: string };
      expect(body).toEqual({ dispatchId: 'd-1' });
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get('/api/v1/incidents/i-new', () => HttpResponse.json(created)),
  );

  const user = userEvent.setup();
  renderIncidents(['CHIEF']);
  await screen.findByRole('heading', { name: 'Incidents' });
  await user.type(screen.getByLabelText('Dispatch ID'), 'd-1');
  await user.click(screen.getByRole('button', { name: 'Create report' }));

  await screen.findByRole('heading', { level: 1, name: /212 Church Hill Rd/ });
  expect(screen.getByLabelText('Address')).toHaveProperty(
    'value',
    '212 Church Hill Rd, Trumbull, CT',
  );
  expect(screen.getByLabelText('Incident type')).toHaveProperty('value', 'Structure fire');
  expect(screen.getByLabelText('Narrative')).toHaveProperty(
    'value',
    'Smoke showing on arrival, Engine 301 first-due, Truck 304 laddered the rear.',
  );
  expect(screen.getByLabelText('Alarm time').getAttribute('value')).not.toBe('');
  expect(screen.getByLabelText('Dispatch time').getAttribute('value')).not.toBe('');
  expect(screen.getByLabelText('Responding units')).toHaveProperty(
    'value',
    'Engine 301, Truck 304',
  );
  expect(screen.getByLabelText('Responding members')).toHaveProperty('value', 'm-rivera, m-chen');
});

test('unknown dispatch shows the problem title and detail and moves focus to it', async () => {
  server.use(
    http.get('/api/v1/incidents', () => HttpResponse.json({ incidents: [] })),
    http.post('/api/v1/incidents', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'No dispatch alert found for dispatchId "missing".',
          traceId: 'trace-1',
        },
        { status: 404 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER']);
  await screen.findByRole('heading', { name: 'Incidents' });
  await user.type(screen.getByLabelText('Dispatch ID'), 'missing');
  await user.click(screen.getByRole('button', { name: 'Create report' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Not Found');
  expect(alert.textContent).toContain('No dispatch alert found for dispatchId "missing".');
  await waitFor(() => expect(document.activeElement).toBe(alert));
});

test('an invalid NERIS code blocks the step, shows allowed values, and focuses the field', async () => {
  let puts = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1', () => {
      puts += 1;
      return HttpResponse.json(detail());
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));
  await screen.findByLabelText('NERIS incident type');
  fireEvent.change(screen.getByLabelText('Action taken'), { target: { value: 'NOT_A_CODE' } });
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));

  expect((await screen.findByRole('alert')).textContent).toMatch(
    /must be one of: EXTINGUISH, INVESTIGATE, ASSIST_EMS, NO_ACTION/,
  );
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Action taken')));
  expect(screen.getByRole('heading', { level: 2, name: 'Incident type and actions' })).toBeTruthy();
  expect(puts).toBe(0);
});

test('the incident type picker lists NERIS labels by category and saves the NERIS value', async () => {
  const puts: Array<{ fields: Record<string, string> }> = [];
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1', async ({ request }) => {
      const body = (await request.json()) as { fields: Record<string, string> };
      puts.push(body);
      return HttpResponse.json(
        detail({ corePayload: { ...detail().corePayload, ...body.fields } }),
      );
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));

  const picker = await screen.findByLabelText('NERIS incident type');
  const category = screen.getByLabelText(/Incident category/);
  expect(category).toHaveProperty('value', 'FIRE');
  expect(
    within(category)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['All categories', 'Fire', 'Medical', 'No emergency']);
  expect(picker.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText('Selected: Fire › Structure fire › Room and contents fire')).toBeTruthy();

  // Narrowing to another category drops the Fire types and clears the Fire choice.
  await user.selectOptions(category, 'MEDICAL');
  expect(
    within(picker).queryByRole('option', { name: 'Structure fire › Chimney fire' }),
  ).toBeNull();
  expect(within(picker).getByRole('option', { name: 'Illness › Breathing problems' })).toBeTruthy();
  expect(picker).toHaveProperty('value', '');

  await user.selectOptions(category, '');
  await user.selectOptions(picker, 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE');
  expect(screen.getByText('Selected: Fire › Structure fire › Chimney fire')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]?.fields.incident_type).toBe('FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE');
});

test('without downloaded NERIS types the picker says so and the step still saves', async () => {
  const puts: Array<{ fields: Record<string, string> }> = [];
  server.use(
    http.get('/api/v1/incidents/neris-schema', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: "The NERIS schema hasn't been downloaded yet.",
          traceId: 'trace-503',
          code: 'NERIS_SCHEMA_UNAVAILABLE',
        },
        { status: 503 },
      ),
    ),
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1', async ({ request }) => {
      const body = (await request.json()) as { fields: Record<string, string> };
      puts.push(body);
      return HttpResponse.json(detail());
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));

  expect(await screen.findByText(/NERIS incident types are not downloaded yet/)).toBeTruthy();
  expect(screen.queryByLabelText('NERIS incident type')).toBeNull();
  fireEvent.change(screen.getByLabelText('Action taken'), { target: { value: 'EXTINGUISH' } });
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({ fields: { action_taken: 'EXTINGUISH' } });
});

test('a stored non-NERIS incident type is flagged, not silently dropped or re-sent', async () => {
  const legacy = detail({
    corePayload: { incident_type: 'STRUCTURE_FIRE', address: '14 Elm St, Trumbull, CT' },
  });
  const puts: Array<{ fields: Record<string, string> }> = [];
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(legacy)),
    http.put('/api/v1/incidents/i-1', async ({ request }) => {
      const body = (await request.json()) as { fields: Record<string, string> };
      puts.push(body);
      return HttpResponse.json(legacy);
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));

  const picker = await screen.findByLabelText('NERIS incident type');
  expect(picker).toHaveProperty('value', '');
  const hint = screen.getByText('Not a NERIS type: STRUCTURE_FIRE — pick one.');
  expect(picker.getAttribute('aria-describedby')).toContain(hint.id);

  fireEvent.change(screen.getByLabelText('Action taken'), { target: { value: 'EXTINGUISH' } });
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({ fields: { action_taken: 'EXTINGUISH' } });
});

test('a server enumeration 400 is mapped onto the field and blocks progress', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'One or more fields failed NERIS enumeration validation.',
          traceId: 'trace-2',
          errors: [{ field: 'action_taken', message: 'must be one of: EXTINGUISH, INVESTIGATE' }],
        },
        { status: 400 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));
  fireEvent.change(screen.getByLabelText('Action taken'), { target: { value: 'EXTINGUISH' } });
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));

  expect(await screen.findByText('must be one of: EXTINGUISH, INVESTIGATE')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Action taken')));
  expect(screen.getByRole('heading', { level: 2, name: 'Incident type and actions' })).toBeTruthy();
});

test('valid core fields reach Validated and enable Submit', async () => {
  let current = detail();
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(current)),
    http.put('/api/v1/incidents/i-1', async ({ request }) => {
      const body = (await request.json()) as { fields: Record<string, string> };
      current = {
        ...current,
        corePayload: { ...current.corePayload, ...body.fields },
        status: 'VALIDATED',
      };
      return HttpResponse.json(current);
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Incident type and actions' }));
  fireEvent.change(screen.getByLabelText('Action taken'), { target: { value: 'EXTINGUISH' } });
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await user.click(await screen.findByRole('button', { name: 'Review and submit' }));

  expect(await screen.findByText('Validated')).toBeTruthy();
  // Validated is not enough: nothing goes to NERIS until an officer reviews and locks it.
  expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
  expect(
    screen.getByText('Submit stays unavailable until an officer reviews and locks the report.'),
  ).toBeTruthy();
});

test('Submit sends a locked, validated report to NERIS and shows the submission status', async () => {
  let current = detail({ status: 'VALIDATED', lockedAt: 1_798_003_000, lockedBy: 'MBR-0034' });
  let submitCalls = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(current)),
    http.post('/api/v1/incidents/i-1/submit', () => {
      submitCalls += 1;
      current = { ...current, status: 'SUBMITTED' };
      return HttpResponse.json(
        { incidentId: 'i-1', submissionStatus: 'SUBMITTED' },
        { status: 202 },
      );
    }),
    http.get('/api/v1/incidents/i-1/submissions', () =>
      HttpResponse.json({ incidentId: 'i-1', status: 'SUBMITTED', submissionStatus: 'SUBMITTED' }),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['CHIEF'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));
  await user.click(screen.getByRole('button', { name: 'Submit' }));

  expect(await screen.findByText('Sent to NERIS, waiting for a response')).toBeTruthy();
  expect(submitCalls).toBe(1);
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
});

test('a failed NERIS submission shows its reason and can be retried', async () => {
  let submissionStatus = 'FAILED';
  let retryCalls = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(detail({ status: 'SUBMITTED', lockedAt: 1_798_003_000 })),
    ),
    http.get('/api/v1/incidents/i-1/submissions', () =>
      HttpResponse.json({
        incidentId: 'i-1',
        status: 'SUBMITTED',
        submissionStatus,
        ...(submissionStatus === 'FAILED' ? { submissionFailureReason: 'SERVER_ERROR' } : {}),
      }),
    ),
    http.post('/api/v1/incidents/i-1/submission/retry', () => {
      retryCalls += 1;
      submissionStatus = 'RETRYING';
      return HttpResponse.json(
        { incidentId: 'i-1', submissionStatus: 'RETRYING' },
        { status: 202 },
      );
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));

  expect(await screen.findByText('NERIS submission failed')).toBeTruthy();
  expect(screen.getByText('Reason: SERVER_ERROR')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Retry submission' }));
  expect(await screen.findByText('Retrying, NERIS has not accepted it yet')).toBeTruthy();
  expect(retryCalls).toBe(1);
});

test('a submit rejected by the API is shown, not swallowed', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(detail({ status: 'VALIDATED', lockedAt: 1_798_003_000 })),
    ),
    http.post('/api/v1/incidents/i-1/submit', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Submitting an incident to NERIS requires an admin or chief role.',
          traceId: 't-1',
        },
        { status: 403 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));
  await user.click(screen.getByRole('button', { name: 'Submit' }));

  expect(
    (await screen.findAllByText('Submitting an incident to NERIS requires an admin or chief role.'))
      .length,
  ).toBeGreaterThan(0);
});

test('narrative saves and reloads unchanged, and an over-long narrative is kept', async () => {
  let current = detail({ narrative: 'Working fire, first floor kitchen.' });
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(current)),
    http.put('/api/v1/incidents/i-1/narrative', async ({ request }) => {
      const body = (await request.json()) as { narrative: string };
      if (body.narrative.length > 25_000) {
        return HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: `narrative must not exceed 25000 characters; received ${body.narrative.length}`,
            traceId: 'trace-3',
          },
          { status: 400 },
        );
      }
      current = { ...current, narrative: body.narrative };
      return HttpResponse.json(current);
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Narrative' }));
  const editor = screen.getByRole('textbox', { name: 'Narrative' });
  fireEvent.change(editor, { target: { value: 'Kitchen fire held to the room of origin.' } });
  await user.click(screen.getByRole('button', { name: 'Save narrative' }));
  await waitFor(() => expect(current.narrative).toBe('Kitchen fire held to the room of origin.'));

  cleanup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Narrative' }));
  expect(screen.getByRole('textbox', { name: 'Narrative' })).toHaveProperty(
    'value',
    'Kitchen fire held to the room of origin.',
  );

  const tooLong = 'x'.repeat(25_001);
  fireEvent.change(screen.getByRole('textbox', { name: 'Narrative' }), {
    target: { value: tooLong },
  });
  await user.click(screen.getByRole('button', { name: 'Save narrative' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /narrative must not exceed 25000 characters/,
  );
  expect(screen.getByRole('textbox', { name: 'Narrative' })).toHaveProperty('value', tooLong);
});

test('saving arrived time sends only that field and leaves the other timestamps', async () => {
  const units = detail().respondingUnits ?? [];
  let stored = units.map((unit) => ({ ...unit }));
  let lastBody: Record<string, unknown> | undefined;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail({ respondingUnits: stored }))),
    http.put('/api/v1/incidents/i-1/response-times', async ({ request }) => {
      lastBody = (await request.json()) as Record<string, unknown>;
      stored = stored.map((unit) =>
        unit.unitId === lastBody?.unitId
          ? { ...unit, arrivedAt: lastBody.arrivedAt as number }
          : unit,
      );
      const saved = stored.find((unit) => unit.unitId === lastBody?.unitId);
      return HttpResponse.json(saved);
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Apparatus and personnel' }));
  expect(screen.getByRole('heading', { name: 'Engine 301' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Truck 304' })).toBeTruthy();

  const dispatched = screen.getByLabelText('Dispatched for Engine 301');
  const before = (dispatched as HTMLInputElement).value;
  fireEvent.change(screen.getByLabelText('Arrived for Engine 301'), {
    target: { value: '2026-01-15T14:30' },
  });
  await user.click(screen.getByRole('button', { name: 'Save arrived time for Engine 301' }));

  await waitFor(() => {
    expect(lastBody).toEqual({
      unitId: 'Engine 301',
      unitType: 'APPARATUS',
      arrivedAt: dateTimeLocalToEpoch('2026-01-15T14:30'),
    });
  });
  expect(Object.keys(lastBody ?? {}).sort()).toEqual(['arrivedAt', 'unitId', 'unitType']);
  expect((screen.getByLabelText('Dispatched for Engine 301') as HTMLInputElement).value).toBe(
    before,
  );
  expect(screen.getByText('Assigned position: Officer')).toBeTruthy();
});

test('exposure modules save, reject an invalid enum, and stay hidden when the API omits them', async () => {
  const record = detail({
    secondaryModules: [
      {
        incidentId: 'i-1',
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['m-rivera'],
        complete: true,
        updatedAt: 1,
      },
      {
        incidentId: 'i-1',
        secondaryType: 'RESPONDER_SAFETY',
        payload: { injury_type: 'NONE' },
        affectedMemberIds: ['m-chen'],
        complete: true,
        updatedAt: 1,
      },
    ],
  });
  server.use(http.get('/api/v1/incidents/i-1', () => HttpResponse.json(record)));

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Exposure and responder safety' }));
  expect(screen.getByRole('heading', { name: 'Exposure' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Responder safety' })).toBeTruthy();
  expect(screen.getByText('Affected members: m-rivera')).toBeTruthy();
  expect(screen.getByText('Affected members: m-chen')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Exposure type'), { target: { value: 'NOT_SMOKE' } });
  await user.click(screen.getByRole('button', { name: 'Mark complete' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /must be one of: SMOKE, CHEMICAL, BLOODBORNE/,
  );
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Exposure type')));
});

test('the exposure section is not rendered when the API does not return it', async () => {
  const { secondaryModules: _omitted, ...withoutSecondary } = detail();
  void _omitted;
  server.use(http.get('/api/v1/incidents/i-1', () => HttpResponse.json(withoutSecondary)));

  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  expect(screen.queryByRole('button', { name: 'Exposure and responder safety' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Exposure and responder safety' })).toBeNull();
});

test('a member cannot open the incident list', async () => {
  renderIncidents(['MEMBER']);
  expect(await screen.findByRole('heading', { name: 'Forbidden' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Incidents' })).toBeNull();
});

const LOCKED = { lockedAt: 1_700_100_000, lockedBy: 'Capt. Nolan' };

async function reviewPanel() {
  return within(await screen.findByRole('region', { name: /blocking lock/ }));
}

test('the review checklist lists blocking before warnings, goes to the field, and a fix sends the right PUT', async () => {
  let fixed = false;
  const modes: string[] = [];
  let timesBody: unknown;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.post('/api/v1/incidents/i-1/validate', async ({ request }) => {
      modes.push(((await request.json()) as { mode: string }).mode);
      if (fixed) return HttpResponse.json(cleanReport());
      return HttpResponse.json({
        ...cleanReport(),
        blocking: [
          {
            path: 'units.Truck 304.arrivedAt',
            code: 'MISSING_TIME',
            message: 'Truck 304 has no arrived time.',
            section: 'units',
            fix: {
              label: 'Use 14:32 for Truck 304',
              path: 'units.Truck 304.arrivedAt',
              value: 1_700_000_400,
            },
          },
        ],
        warnings: [
          {
            path: 'narrative',
            code: 'SHORT',
            message: 'The narrative is shorter than usual.',
            section: 'narrative',
          },
        ],
        sectionsComplete: { core: true, units: false },
      });
    }),
    http.put('/api/v1/incidents/i-1/response-times', async ({ request }) => {
      timesBody = await request.json();
      fixed = true;
      return HttpResponse.json({
        incidentId: 'i-1',
        unitId: 'Truck 304',
        unitType: 'APPARATUS',
        dispatchedAt: 1_700_000_045,
        arrivedAt: 1_700_000_400,
      });
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  const panel = await reviewPanel();
  expect(await panel.findByText('Truck 304 has no arrived time.')).toBeTruthy();
  const blockingHeading = panel.getByRole('heading', { name: 'Blocking (1)' });
  const warningsHeading = panel.getByRole('heading', { name: 'Warnings (1)' });
  expect(
    blockingHeading.compareDocumentPosition(warningsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(panel.getByText('Units: incomplete')).toBeTruthy();
  expect(panel.getByText('Core: complete')).toBeTruthy();
  expect(panel.getByText('Fire: not checked')).toBeTruthy();
  expect(modes).toEqual(['local']);

  await user.click(panel.getByRole('button', { name: 'Go to Units' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText('Arrived for Truck 304')),
  );

  await user.click(panel.getByRole('button', { name: 'Fix: Use 14:32 for Truck 304' }));
  await waitFor(() =>
    expect(timesBody).toEqual({
      unitId: 'Truck 304',
      unitType: 'APPARATUS',
      arrivedAt: 1_700_000_400,
    }),
  );
  expect(await panel.findByText('Nothing blocking — ready to lock.')).toBeTruthy();
  expect(modes.length).toBeGreaterThanOrEqual(2);
});

test('Check with NERIS validates in both modes and shows when NERIS checked it', async () => {
  const modes: string[] = [];
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.post('/api/v1/incidents/i-1/validate', async ({ request }) => {
      const { mode } = (await request.json()) as { mode: string };
      modes.push(mode);
      return HttpResponse.json({
        ...cleanReport(mode),
        nerisValidatedAt: mode === 'both' ? '2026-09-29T12:00:00.000Z' : null,
      });
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  const panel = await reviewPanel();
  expect(await panel.findByText('Nothing blocking — ready to lock.')).toBeTruthy();
  await user.click(panel.getByRole('button', { name: 'Check with NERIS' }));
  expect(await panel.findByText(/Checked with NERIS at/)).toBeTruthy();
  expect(modes).toEqual(['local', 'both']);
});

test('an officer attests and locks; the banner takes focus and edits close', async () => {
  let current = detail({ status: 'VALIDATED' });
  let lockBody: unknown;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(current)),
    http.post('/api/v1/incidents/i-1/lock', async ({ request }) => {
      lockBody = await request.json();
      current = { ...current, ...LOCKED };
      return HttpResponse.json({
        incidentId: 'i-1',
        ...LOCKED,
        status: 'VALIDATED',
        submission: null,
        nerisValidatedAt: null,
        warnings: [],
      });
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  const panel = await reviewPanel();
  const lock = panel.getByRole('button', { name: 'Lock report' });
  expect(lock).toHaveProperty('disabled', true);
  await user.click(panel.getByRole('checkbox', { name: 'I reviewed this report' }));
  await user.click(panel.getByRole('button', { name: 'Lock report' }));

  const banner = await screen.findByText(/^Locked by Capt\. Nolan at .+; edits are closed\.$/);
  expect(lockBody).toEqual({ attest: true });
  await waitFor(() => expect(document.activeElement).toBe(banner));
  expect(panel.queryByRole('button', { name: 'Lock report' })).toBeNull();
  // Unlock is chief/admin only.
  expect(panel.queryByRole('button', { name: 'Unlock report' })).toBeNull();
  expect(panel.getByText('Only a chief or admin can unlock this report.')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Narrative' }));
  expect(screen.getByRole('button', { name: 'Save narrative' })).toHaveProperty('disabled', true);
});

test('a lock refused with 409 VALIDATION_BLOCKED shows the returned blocking list', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail({ status: 'VALIDATED' }))),
    http.post('/api/v1/incidents/i-1/lock', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: "The report can't be locked yet: 1 item to fix.",
          traceId: 't-9',
          code: 'VALIDATION_BLOCKED',
          blocking: [
            {
              path: 'fields.action_taken',
              code: 'REQUIRED',
              message: 'Action taken is required.',
              section: 'core',
            },
          ],
          warnings: [],
          sectionsComplete: { core: false },
        },
        { status: 409 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['CHIEF'], '/incidents/i-1');
  const panel = await reviewPanel();
  await panel.findByText('Nothing blocking — ready to lock.');
  await user.click(panel.getByRole('checkbox', { name: 'I reviewed this report' }));
  await user.click(panel.getByRole('button', { name: 'Lock report' }));

  expect(await panel.findByText('Lock refused. Fix these first.')).toBeTruthy();
  expect(panel.getByText('Action taken is required.')).toBeTruthy();
  expect(panel.getByText('Core: incomplete')).toBeTruthy();
  expect(screen.queryByText(/edits are closed/)).toBeNull();

  await user.click(panel.getByRole('button', { name: 'Go to Core' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Action taken')));
});

test('a chief unlocks only with a reason; Escape closes the dialog', async () => {
  let current = detail({ status: 'VALIDATED', ...LOCKED });
  let unlockBody: unknown;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(current)),
    http.post('/api/v1/incidents/i-1/unlock', async ({ request }) => {
      unlockBody = await request.json();
      current = { ...current, lockedAt: null, lockedBy: null };
      return HttpResponse.json({
        incidentId: 'i-1',
        unlockedAt: 1_700_200_000,
        unlockedBy: 'u1',
        reason: (unlockBody as { reason: string }).reason,
      });
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['CHIEF'], '/incidents/i-1');
  expect(await screen.findByText(/edits are closed/)).toBeTruthy();
  const panel = await reviewPanel();

  await user.click(panel.getByRole('button', { name: 'Unlock report' }));
  expect(await screen.findByRole('dialog', { name: 'Unlock this report' })).toBeTruthy();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await user.click(panel.getByRole('button', { name: 'Unlock report' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Unlock this report' }));
  await user.click(dialog.getByRole('button', { name: 'Unlock' }));
  expect(await dialog.findByText(/Enter a reason of at least 5 characters/)).toBeTruthy();
  expect(unlockBody).toBeUndefined();

  await user.type(dialog.getByLabelText('Reason for unlocking'), 'Wrong unit times');
  await user.click(dialog.getByRole('button', { name: 'Unlock' }));
  await waitFor(() => expect(unlockBody).toEqual({ reason: 'Wrong unit times' }));
  await waitFor(() => expect(screen.queryByText(/edits are closed/)).toBeNull());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel.getByRole('button', { name: 'Lock report' })).toBeTruthy();
});

function ledgerState(overrides: Partial<SubmissionState> = {}): SubmissionState {
  return {
    incidentId: 'i-1',
    status: 'ACCEPTED',
    submissionStatus: 'ACCEPTED',
    nerisIncidentId: 'FD09190250|26-001841',
    nerisStatus: 'PENDING_APPROVAL',
    nerisStatusAt: 1_700_050_000,
    ...LOCKED,
    payloadHash: 'abc123',
    firstSubmittedAt: 1_700_000_500,
    editedSinceSubmission: true,
    attempts: [
      {
        attempt: 1,
        attemptedAt: '2026-09-20T12:00:00Z',
        outcome: 'VALIDATION_ERROR',
        httpStatus: 422,
        retryCount: 0,
        operation: 'CREATE',
        errors: [
          { path: 'base.incident_type', code: 'INVALID', message: 'Unknown incident type.' },
        ],
      },
      {
        attempt: 2,
        attemptedAt: '2026-09-20T13:00:00Z',
        outcome: 'SUCCESS',
        httpStatus: 201,
        retryCount: 0,
        operation: 'CREATE',
        nerisIncidentId: 'FD09190250|26-001841',
        errors: [],
      },
    ],
    statusHistory: [
      { status: 'SUBMITTED', at: '2026-09-20T13:00:00Z', current: false },
      { status: 'PENDING_APPROVAL', at: '2026-09-21T09:00:00Z', current: true },
    ],
    ...overrides,
  };
}

test('the submission ledger shows NERIS status, id, attempts and history, and resubmit shows the diff', async () => {
  let resubmits = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(
        detail({ status: 'ACCEPTED', ...LOCKED, nerisIncidentId: 'FD09190250|26-001841' }),
      ),
    ),
    http.get('/api/v1/incidents/i-1/submissions', () => HttpResponse.json(ledgerState())),
    http.post('/api/v1/incidents/i-1/resubmit', () => {
      resubmits += 1;
      return HttpResponse.json(
        {
          incidentId: 'i-1',
          nerisIncidentId: 'FD09190250|26-001841',
          diff: [
            { path: 'narrative', before: 'Working fire.', after: 'Working fire, first floor.' },
          ],
          status: 'QUEUED',
          submissionStatus: 'SUBMITTED',
        },
        { status: 202 },
      );
    }),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));

  const ledger = within(await screen.findByRole('region', { name: 'NERIS submission record' }));
  expect(ledger.getAllByText('Waiting for NERIS approval').length).toBe(2);
  expect(ledger.getByText('FD09190250|26-001841')).toBeTruthy();
  expect(ledger.getByText(/edited after it was last sent to NERIS/)).toBeTruthy();

  const table = within(ledger.getByRole('table', { name: 'Submission attempts' }));
  expect(table.getAllByRole('row')).toHaveLength(3);
  expect(table.getByText('Rejected by NERIS validation')).toBeTruthy();
  expect(table.getByText('422')).toBeTruthy();
  expect(table.getByText(/Unknown incident type\./)).toBeTruthy();
  expect(table.getByText('Accepted')).toBeTruthy();
  expect(ledger.getByText('(current)')).toBeTruthy();
  expect(ledger.getByText('Received by NERIS')).toBeTruthy();

  await user.click(ledger.getByRole('button', { name: 'Resubmit to NERIS' }));
  expect(await ledger.findByText('Sent 1 change to NERIS:')).toBeTruthy();
  expect(ledger.getByText(/Working fire\. → Working fire, first floor\./)).toBeTruthy();
  expect(resubmits).toBe(1);
});

test('a resubmit with nothing changed says so', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(
        detail({ status: 'ACCEPTED', ...LOCKED, nerisIncidentId: 'FD09190250|26-001841' }),
      ),
    ),
    http.get('/api/v1/incidents/i-1/submissions', () =>
      HttpResponse.json(ledgerState({ editedSinceSubmission: false })),
    ),
    http.post('/api/v1/incidents/i-1/resubmit', () =>
      HttpResponse.json({ incidentId: 'i-1', diff: [], status: 'UNCHANGED' }),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));
  const ledger = within(await screen.findByRole('region', { name: 'NERIS submission record' }));
  expect(ledger.queryByText(/edited after it was last sent/)).toBeNull();
  await user.click(ledger.getByRole('button', { name: 'Resubmit to NERIS' }));
  expect(await ledger.findByText(/No changes to send/)).toBeTruthy();
});

test('an edit refused with 409 INCIDENT_LOCKED shows the server message', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1/narrative', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This report is locked. A chief or admin must unlock it first.',
          traceId: 't-3',
          code: 'INCIDENT_LOCKED',
        },
        { status: 409 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderIncidents(['OFFICER'], '/incidents/i-1');
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Narrative' }));
  await user.click(screen.getByRole('button', { name: 'Save narrative' }));
  expect(
    (await screen.findAllByText('This report is locked. A chief or admin must unlock it first.'))
      .length,
  ).toBeGreaterThan(0);
});
