import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User, UserManager } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { IncidentDetailPage } from './IncidentDetailPage';
import { modulesForIncident, pruneValue } from './nerisModuleSchema';
import { DEMO_NERIS_SCHEMA } from './nerisSchemaFixture';
import type { IncidentDetail, ValidationReport } from './types';

function report(blocking: ValidationReport['blocking'] = []): ValidationReport {
  return {
    incidentId: 'i-1',
    mode: 'local',
    blocking,
    warnings: [],
    nerisValidatedAt: null,
    sectionsComplete: { core: true, fire: blocking.length === 0 },
  };
}

const server = setupServer(
  http.post('/api/v1/incidents/:incidentId/validate', () => HttpResponse.json(report())),
  http.get('/api/v1/incidents/neris-schema', () => HttpResponse.json(DEMO_NERIS_SCHEMA)),
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
    profile: { sub: 'u1', 'cognito:groups': ['OFFICER'] },
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

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider userManager={makeManager()}>
        <MemoryRouter initialEntries={['/incidents/i-1']}>
          <Routes>
            <Route path="/incidents/:id" element={<IncidentDetailPage />} />
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
      action_taken: 'EXTINGUISH',
    },
    incidentType: 'Structure fire',
    address: '14 Elm St, Trumbull, CT',
    narrative: 'Working fire, first floor kitchen.',
    status: 'DRAFT',
    sourceDispatchId: 'd-100',
    createdBy: 'm-1',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    secondaryModules: [],
    respondingUnits: [],
    respondingMembers: [],
    ...overrides,
  };
}

async function openFireProtection(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Fire protection systems' }));
  return within(await screen.findByRole('region', { name: 'Smoke alarm' }));
}

test('the step shows the structure-fire modules, and cooking suppression only for cooking fires', () => {
  expect(
    modulesForIncident('FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', {}).map((item) => item.module),
  ).toEqual(['smoke_alarm', 'fire_alarm', 'other_alarm', 'fire_suppression']);
  expect(
    modulesForIncident('FIRE||STRUCTURE_FIRE||CONFINED_COOKING_APPLIANCE_FIRE', {}).map(
      (item) => item.module,
    ),
  ).toContain('cooking_fire_suppression');
  expect(modulesForIncident('NOEMERG||CANCELLED', {})).toEqual([]);
  // A value already entered stays visible even when the type no longer requires it.
  expect(modulesForIncident('NOEMERG||CANCELLED', { fire_alarm: { presence: {} } })).toEqual([
    { module: 'fire_alarm', required: false },
  ]);
});

test('pruning keeps what was entered and drops empties and the other branch', () => {
  const smoke = DEMO_NERIS_SCHEMA.modules.smoke_alarm!;
  expect(
    pruneValue(smoke.defs, smoke.node, {
      presence: { type: 'NOT_PRESENT', working: true, alarm_types: [] },
      stray: 'x',
    }),
  ).toEqual({ presence: { type: 'NOT_PRESENT' } });
});

test('the smoke alarm editor renders the present / not-present branches and saves the NERIS value', async () => {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1/modules/smoke_alarm', async ({ request }) => {
      const body = (await request.json()) as { value: Record<string, unknown> };
      puts.push(body);
      return HttpResponse.json(
        detail({ corePayload: { ...detail().corePayload, smoke_alarm: body.value } }),
      );
    }),
  );

  const user = userEvent.setup();
  renderReport();
  const smoke = await openFireProtection(user);
  expect(screen.getByRole('region', { name: 'Fire alarm' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Cooking fire suppression' })).toBeNull();

  const presence = smoke.getByRole('group', { name: 'Presence (required)' });
  expect(
    within(presence)
      .getAllByRole('radio')
      .map((radio) => radio.parentElement?.textContent),
  ).toEqual(['Present', 'Not present', 'Not applicable']);
  expect(smoke.queryByRole('group', { name: 'Working' })).toBeNull();

  await user.click(within(presence).getByRole('radio', { name: 'Present' }));
  const working = smoke.getByRole('group', { name: 'Working' });
  expect(within(working).getByRole('radio', { name: 'Unknown' })).toHaveProperty('checked', true);
  await user.click(within(working).getByRole('radio', { name: 'Yes' }));
  const types = smoke.getByRole('group', { name: 'Alarm types — select all that apply' });
  await user.click(within(types).getByRole('checkbox', { name: 'Hardwired' }));
  await user.click(within(types).getByRole('checkbox', { name: 'Interconnected' }));
  const outcome = smoke.getByRole('group', { name: 'Alerted failed other (required)' });
  await user.click(within(outcome).getByRole('radio', { name: 'Failed to operate' }));
  await user.selectOptions(smoke.getByLabelText('Failure reason'), 'EXPIRED');

  // Switching to Not present drops the Present branch's fields from what is sent.
  await user.click(within(presence).getByRole('radio', { name: 'Not present' }));
  expect(smoke.queryByRole('group', { name: 'Working' })).toBeNull();
  await user.click(within(presence).getByRole('radio', { name: 'Present' }));
  await user.click(
    within(smoke.getByRole('group', { name: 'Working' })).getByRole('radio', { name: 'No' }),
  );
  await user.click(
    within(smoke.getByRole('group', { name: 'Alarm types — select all that apply' })).getByRole(
      'checkbox',
      { name: 'Hardwired' },
    ),
  );
  await user.click(
    within(smoke.getByRole('group', { name: 'Alerted failed other (required)' })).getByRole(
      'radio',
      { name: 'Operated alerted occupant' },
    ),
  );
  await user.click(smoke.getByRole('button', { name: 'Save smoke alarm' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    value: {
      presence: {
        type: 'PRESENT',
        working: false,
        alarm_types: ['HARDWIRED'],
        operation: { alerted_failed_other: { type: 'OPERATED_ALERTED_OCCUPANT' } },
      },
    },
  });
  expect(await smoke.findByText('Recorded')).toBeTruthy();
});

test('a 400 lands inline on the field and focus moves to it', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.put('/api/v1/incidents/i-1/modules/smoke_alarm', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The smoke alarm is not complete.',
          traceId: 'trace-400',
          errors: [{ field: 'presence.operation.alerted_failed_other', message: 'is required' }],
        },
        { status: 400 },
      ),
    ),
  );

  const user = userEvent.setup();
  renderReport();
  const smoke = await openFireProtection(user);
  await user.click(
    within(smoke.getByRole('group', { name: 'Presence (required)' })).getByRole('radio', {
      name: 'Present',
    }),
  );
  await user.click(smoke.getByRole('button', { name: 'Save smoke alarm' }));

  const group = await smoke.findByRole('group', { name: 'Alerted failed other (required)' });
  const first = within(group).getByRole('radio', { name: 'Operated alerted occupant' });
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(first.getAttribute('aria-invalid')).toBe('true');
  const describedBy = first.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(describedBy)?.textContent).toBe('is required');
  expect(smoke.getByText('Presence › Operation › Alerted failed other is required')).toBeTruthy();
});

test('editors are disabled on a locked report', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(detail({ lockedAt: 1_798_003_000, lockedBy: 'MBR-0034' })),
    ),
  );
  const user = userEvent.setup();
  renderReport();
  const smoke = await openFireProtection(user);
  // The editor's fieldset is disabled, which disables every control inside it.
  expect(smoke.getByRole('radio', { name: 'Present' }).matches(':disabled')).toBe(true);
  expect(smoke.getByRole('button', { name: 'Save smoke alarm' })).toHaveProperty('disabled', true);
});

test('"Go to" on a MODULE_REQUIRED item opens the step and focuses that module editor', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.post('/api/v1/incidents/:incidentId/validate', () =>
      HttpResponse.json(
        report([
          {
            path: 'modules.fire_alarm',
            code: 'MODULE_REQUIRED',
            message: 'Structure fires need the fire alarm.',
            section: 'fire',
          },
        ]),
      ),
    ),
  );

  const user = userEvent.setup();
  renderReport();
  const panel = within(await screen.findByRole('region', { name: /blocking lock/ }));
  expect(await panel.findByText('Structure fires need the fire alarm.')).toBeTruthy();
  await user.click(panel.getByRole('button', { name: 'Go to Fire' }));

  expect(
    await screen.findByRole('heading', { level: 2, name: 'Fire protection systems' }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 3, name: 'Fire alarm' }),
    ),
  );
});
