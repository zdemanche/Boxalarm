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
import { DEMO_NERIS_SCHEMA } from './nerisSchemaFixture';
import type { IncidentDetail, SubmissionState } from './types';

const NERIS_ID = 'FD09190250|26-001841';
const LOCKED = { lockedAt: 1_798_003_000, lockedBy: 'MBR-0034' };

const server = setupServer(
  http.post('/api/v1/incidents/:incidentId/validate', () =>
    HttpResponse.json({
      incidentId: 'i-1',
      mode: 'local',
      blocking: [],
      warnings: [],
      nerisValidatedAt: null,
      sectionsComplete: {},
    }),
  ),
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

async function openReview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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
  const user = userEvent.setup();
  await screen.findByRole('heading', { level: 1, name: /14 Elm St/ });
  await user.click(screen.getByRole('button', { name: 'Review and submit' }));
  return user;
}

function detail(overrides: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    incidentId: 'i-1',
    deptId: 'nichols-fd',
    dispatchNumber: '26-001841',
    epochSeconds: 1_700_000_000,
    nerisSchemaVersion: '2026.2',
    corePayload: { incident_type: 'NOEMERG||CANCELLED', action_taken: 'NO_ACTION' },
    incidentType: 'Cancelled',
    address: '14 Elm St, Trumbull, CT',
    narrative: 'Cancelled en route.',
    status: 'VALIDATED',
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

function ledger(overrides: Partial<SubmissionState> = {}): SubmissionState {
  return {
    incidentId: 'i-1',
    status: 'VALIDATED',
    submissionStatus: 'ACCEPTED',
    nerisIncidentId: NERIS_ID,
    nerisStatus: 'PENDING_APPROVAL',
    firstSubmittedAt: 1_700_000_500,
    editedSinceSubmission: true,
    attempts: [],
    statusHistory: [],
    ...LOCKED,
    ...overrides,
  };
}

test('re-locked after an edit (VALIDATED again): the ledger stays and Resubmit replaces Submit', async () => {
  let resubmits = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(
        detail({ ...LOCKED, nerisIncidentId: NERIS_ID, submissionStatus: 'ACCEPTED' }),
      ),
    ),
    http.get('/api/v1/incidents/i-1/submissions', () => HttpResponse.json(ledger())),
    http.post('/api/v1/incidents/i-1/resubmit', () => {
      resubmits += 1;
      return HttpResponse.json(
        {
          incidentId: 'i-1',
          nerisIncidentId: NERIS_ID,
          diff: [{ path: 'narrative', before: 'Cancelled.', after: 'Cancelled en route.' }],
          status: 'QUEUED',
          submissionStatus: 'SUBMITTED',
        },
        { status: 202 },
      );
    }),
  );

  const user = await openReview();
  const record = within(await screen.findByRole('region', { name: 'NERIS submission record' }));
  expect(record.getByText(NERIS_ID)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();

  await user.click(record.getByRole('button', { name: 'Resubmit to NERIS' }));
  expect(await record.findByText('Sent 1 change to NERIS:')).toBeTruthy();
  expect(resubmits).toBe(1);
});

test('unlocked for edits: the ledger stays, with no Submit and no Resubmit until re-locked', async () => {
  server.use(
    http.get('/api/v1/incidents/i-1', () =>
      HttpResponse.json(detail({ status: 'DRAFT', nerisIncidentId: NERIS_ID })),
    ),
    http.get('/api/v1/incidents/i-1/submissions', () =>
      HttpResponse.json(ledger({ status: 'DRAFT', lockedAt: null, lockedBy: null })),
    ),
  );

  await openReview();
  const record = within(await screen.findByRole('region', { name: 'NERIS submission record' }));
  expect(record.getByText(NERIS_ID)).toBeTruthy();
  expect(
    screen.getByText(
      'NERIS already has this report. Lock it again after review, then resubmit the changes.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  expect(record.queryByRole('button', { name: 'Resubmit to NERIS' })).toBeNull();
});

test('sent before but without a NERIS id: the ledger shows, and a 409 USE_RESUBMIT swaps Submit for Resubmit', async () => {
  let gets = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () => {
      gets += 1;
      return HttpResponse.json(
        gets === 1
          ? detail({ ...LOCKED, firstSubmittedAt: 1_700_000_500 })
          : detail({ ...LOCKED, firstSubmittedAt: 1_700_000_500, nerisIncidentId: NERIS_ID }),
      );
    }),
    http.get('/api/v1/incidents/i-1/submissions', () =>
      HttpResponse.json(
        gets <= 1
          ? ledger({ nerisIncidentId: null, submissionStatus: 'FAILED' })
          : ledger({ submissionStatus: 'ACCEPTED' }),
      ),
    ),
    http.post('/api/v1/incidents/i-1/submit', () =>
      HttpResponse.json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'NERIS already has this report; send the changes with Resubmit.',
          traceId: 'trace-409',
          code: 'USE_RESUBMIT',
        },
        { status: 409 },
      ),
    ),
  );

  const user = await openReview();
  expect(await screen.findByRole('region', { name: 'NERIS submission record' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Submit' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'NERIS already has this report; send the changes with Resubmit.',
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull());
  expect(await screen.findByRole('button', { name: 'Resubmit to NERIS' })).toBeTruthy();
});

test('never sent: no ledger, and Submit waits for the lock', async () => {
  let submissionReads = 0;
  server.use(
    http.get('/api/v1/incidents/i-1', () => HttpResponse.json(detail())),
    http.get('/api/v1/incidents/i-1/submissions', () => {
      submissionReads += 1;
      return HttpResponse.json(ledger());
    }),
  );

  await openReview();
  expect(screen.getByRole('button', { name: 'Submit' })).toHaveProperty('disabled', true);
  expect(
    screen.getByText('Submit stays unavailable until an officer reviews and locks the report.'),
  ).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'NERIS submission record' })).toBeNull();
  expect(submissionReads).toBe(0);
});
