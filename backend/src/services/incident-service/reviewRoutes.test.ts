import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { DEFAULT_NERIS_SETTINGS } from './nerisSettings.js';
import { CHIEF_AUTH, OFFICER_AUTH, buildIncidentEvent } from './testEvents.js';
import compiled from './neris/fixtures/neris-api-1.5.1.json' with { type: 'json' };

/** validate / lock / unlock / resubmit routes, with Verified Permissions and storage faked. */

const vpSend = vi.fn();
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vpSend })),
  };
});

const INCIDENT_ID = 'NICHOLS-4471-1798000000';
const ALARM = 1_798_000_000;

function incident(overrides: Record<string, unknown> = {}) {
  return {
    incidentId: INCIDENT_ID,
    deptId: 'NICHOLS',
    dispatchNumber: '4471',
    epochSeconds: ALARM,
    nerisSchemaVersion: '2026.2',
    corePayload: { incident_type: 'FIRE||OUTSIDE_FIRE||DUMPSTER_OUTDOOR_CONTAINER_FIRE' },
    address: '12 Main St, Trumbull, CT 06611',
    alarmAt: ALARM,
    narrative: 'Dumpster fire, knocked down.',
    status: 'DRAFT',
    sourceDispatchId: INCIDENT_ID,
    createdBy: 'MBR-0034',
    createdAt: ALARM,
    updatedAt: ALARM + 500,
    contentVersion: 4,
    ...overrides,
  };
}

const COMPLETE_UNIT = {
  unitId: 'E1',
  unitType: 'APPARATUS',
  dispatchedAt: ALARM + 60,
  arrivedAt: ALARM + 400,
  clearedAt: ALARM + 1_800,
};

const settings = (overrides: Record<string, unknown> = {}) => ({
  ...DEFAULT_NERIS_SETTINGS,
  departmentNerisId: 'FD09190828',
  unitNerisIds: { E1: 'FD09190828S001U001' },
  ...overrides,
});

const validateIncident = vi.fn();
const review = {
  lockIncident: vi.fn(),
  unlockIncident: vi.fn(),
  enqueueResubmission: vi.fn(),
  getLastAcceptedPayload: vi.fn(),
};

function mockContext(context: unknown): void {
  vi.doMock('./reportContext.js', () => ({
    loadReportContext: () => Promise.resolve(context),
    nerisApiFromEnv: () => Promise.resolve({ validateIncident }),
  }));
}

function mockReview(): void {
  vi.doMock('./reviewRepository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./reviewRepository.js')>();
    return { ...actual, ...review };
  });
}

async function call(
  file: string,
  routeKey: string,
  body?: unknown,
  auth: Record<string, unknown> = OFFICER_AUTH,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { handler } = (await import(file)) as {
    handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  };
  const result = await handler(
    buildIncidentEvent({ method: 'POST', routeKey, auth, incidentId: INCIDENT_ID, body }),
  );
  return {
    statusCode: result.statusCode,
    json: JSON.parse(result.body) as Record<string, unknown>,
  };
}

let spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  validateIncident.mockResolvedValue({ ok: true, httpStatus: 204 });
  spies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  mockReview();
});

afterEach(() => {
  vi.doUnmock('./reportContext.js');
  vi.doUnmock('./reviewRepository.js');
  // Not vi.restoreAllMocks(): it would also wipe the module-level Verified Permissions mock.
  spies.forEach((spy) => spy.mockRestore());
});

describe('POST /incidents/{id}/validate', () => {
  const route = 'POST /api/v1/incidents/{incidentId}/validate';

  it('authorizes ValidateIncidentReport on the Boxalarm::Incident and returns the report', async () => {
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    const { statusCode, json } = await call('./validateIncident.js', route, { mode: 'both' });

    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ incidentId: INCIDENT_ID, mode: 'both', blocking: [] });
    expect(typeof json.nerisValidatedAt).toBe('string');
    const vpInput = (vpSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(vpInput).toMatchObject({
      action: { actionType: 'Boxalarm::Action', actionId: 'ValidateIncidentReport' },
      resource: { entityType: 'Boxalarm::Incident', entityId: INCIDENT_ID },
    });
  });

  it('runs only the local checks for a member (no NERIS call on department credentials)', async () => {
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    const { statusCode, json } = await call(
      './validateIncident.js',
      route,
      { mode: 'both' },
      { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' },
    );
    expect(statusCode).toBe(200);
    expect(json.mode).toBe('local');
    expect(validateIncident).not.toHaveBeenCalled();
  });

  it('returns 403 when Cedar denies', async () => {
    vpSend.mockResolvedValue({ decision: Decision.DENY });
    mockContext({ incident: incident(), units: [], settings: settings() });
    expect((await call('./validateIncident.js', route, {})).statusCode).toBe(403);
  });

  it('rejects an unknown mode and a missing incident', async () => {
    mockContext(undefined);
    expect((await call('./validateIncident.js', route, { mode: 'strict' })).statusCode).toBe(400);
    expect((await call('./validateIncident.js', route, { mode: 'local' })).statusCode).toBe(404);
  });
});

describe('POST /incidents/{id}/lock', () => {
  const route = 'POST /api/v1/incidents/{incidentId}/lock';

  it('refuses with 409 and the blocking list when the report is not ready', async () => {
    mockContext({ incident: incident({ narrative: undefined }), units: [], settings: settings() });
    const { statusCode, json } = await call('./lockIncident.js', route, { attest: true });

    expect(statusCode).toBe(409);
    expect(json.code).toBe('VALIDATION_BLOCKED');
    expect((json.blocking as { code: string }[]).map((i) => i.code)).toEqual([
      'NARRATIVE_REQUIRED',
    ]);
    expect(review.lockIncident).not.toHaveBeenCalled();
  });

  it('locks a clean report, pinned to the contentVersion it validated', async () => {
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    review.lockIncident.mockResolvedValue({ status: 'VALIDATED' });
    const { statusCode, json } = await call('./lockIncident.js', route, { attest: true });

    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ lockedBy: 'MBR-0034', status: 'VALIDATED', submission: null });
    expect(review.lockIncident).toHaveBeenCalledWith(
      expect.anything(),
      'incident-table',
      expect.objectContaining({ reviewedContentVersion: 4, submit: false }),
    );
  });

  it('queues the NERIS submission in the same step when autoSubmitOnLock is on', async () => {
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings({ autoSubmitOnLock: true }),
    });
    review.lockIncident.mockResolvedValue({ status: 'SUBMITTED', submissionStatus: 'SUBMITTED' });
    const { json } = await call('./lockIncident.js', route);

    expect(json.submission).toEqual({ status: 'QUEUED' });
    expect(review.lockIncident).toHaveBeenCalledWith(
      expect.anything(),
      'incident-table',
      expect.objectContaining({ submit: true }),
    );
  });

  it('does not auto-submit while submissions are switched off', async () => {
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings({ autoSubmitOnLock: true, submissionsEnabled: false }),
    });
    review.lockIncident.mockResolvedValue({ status: 'VALIDATED' });
    await call('./lockIncident.js', route);
    expect(review.lockIncident).toHaveBeenCalledWith(
      expect.anything(),
      'incident-table',
      expect.objectContaining({ submit: false }),
    );
  });

  it('locks through a NERIS outage, reporting it as a warning', async () => {
    validateIncident.mockRejectedValue(new Error('ETIMEDOUT'));
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    review.lockIncident.mockResolvedValue({ status: 'VALIDATED' });
    const { statusCode, json } = await call('./lockIncident.js', route);
    expect(statusCode).toBe(200);
    expect((json.warnings as { code: string }[]).map((w) => w.code)).toContain('NERIS_UNREACHABLE');
  });

  it('locks when the NERIS config or secret cannot be read, with a warning instead of a 503', async () => {
    vi.doMock('./reportContext.js', () => ({
      loadReportContext: () =>
        Promise.resolve({
          incident: incident(),
          units: [COMPLETE_UNIT],
          settings: settings(),
          nerisApi: compiled,
        }),
      nerisApiFromEnv: () =>
        Promise.reject(
          new Error('Secret boxalarm-dev-neris-client-credentials has no SecretString value'),
        ),
    }));
    review.lockIncident.mockResolvedValue({ status: 'VALIDATED' });
    const { statusCode, json } = await call('./lockIncident.js', route);
    expect(statusCode).toBe(200);
    expect((json.warnings as { code: string }[]).map((w) => w.code)).toContain('NERIS_UNREACHABLE');

    vi.resetModules();
    mockReview();
    vi.doMock('./reportContext.js', () => ({
      loadReportContext: () =>
        Promise.resolve({
          incident: incident(),
          units: [COMPLETE_UNIT],
          settings: settings(),
          nerisApi: compiled,
        }),
      nerisApiFromEnv: () => Promise.reject(new Error('ThrottlingException')),
    }));
    const validated = await call(
      './validateIncident.js',
      'POST /api/v1/incidents/{incidentId}/validate',
      {
        mode: 'both',
      },
    );
    expect(validated.statusCode).toBe(200);
  });

  it('answers 409 for an already-locked report and for a report edited during review', async () => {
    mockContext({ incident: incident({ lockedAt: ALARM + 900 }), units: [], settings: settings() });
    expect((await call('./lockIncident.js', route)).json.code).toBe('ALREADY_LOCKED');

    vi.resetModules();
    mockReview();
    mockContext({
      incident: incident(),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    const { ReviewConflictError } = await import('./reviewRepository.js');
    review.lockIncident.mockRejectedValue(new ReviewConflictError('CHANGED_SINCE_REVIEW'));
    const { statusCode, json } = await call('./lockIncident.js', route);
    expect(statusCode).toBe(409);
    expect(json.code).toBe('CHANGED_SINCE_REVIEW');
  });
});

describe('POST /incidents/{id}/unlock', () => {
  const route = 'POST /api/v1/incidents/{incidentId}/unlock';

  it('requires a reason', async () => {
    expect((await call('./unlockIncident.js', route, {}, CHIEF_AUTH)).statusCode).toBe(400);
    expect((await call('./unlockIncident.js', route, { reason: 'x' }, CHIEF_AUTH)).statusCode).toBe(
      400,
    );
  });

  it('unlocks with the reason recorded, authorizing UnlockIncidentReport', async () => {
    review.unlockIncident.mockResolvedValue(undefined);
    const { statusCode, json } = await call(
      './unlockIncident.js',
      route,
      { reason: 'Wrong unit times for E1' },
      CHIEF_AUTH,
    );
    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ unlockedBy: 'MBR-0001', reason: 'Wrong unit times for E1' });
    expect(review.unlockIncident).toHaveBeenCalledWith(
      expect.anything(),
      'incident-table',
      expect.objectContaining({ actorId: 'MBR-0001', reason: 'Wrong unit times for E1' }),
    );
    expect(
      (vpSend.mock.calls[0]![0] as { input: { action: { actionId: string } } }).input.action
        .actionId,
    ).toBe('UnlockIncidentReport');
  });

  it('refuses while a NERIS submission is in flight', async () => {
    const { ReviewConflictError } = await import('./reviewRepository.js');
    review.unlockIncident.mockRejectedValue(new ReviewConflictError('SUBMISSION_IN_FLIGHT'));
    const { statusCode, json } = await call(
      './unlockIncident.js',
      route,
      { reason: 'Wrong unit times for E1' },
      CHIEF_AUTH,
    );
    expect(statusCode).toBe(409);
    expect(json.code).toBe('SUBMISSION_IN_FLIGHT');
  });
});

describe('POST /incidents/{id}/resubmit', () => {
  const route = 'POST /api/v1/incidents/{incidentId}/resubmit';
  const nerisIncidentId = 'FD09190828|4471|1798000000';

  it('refuses a report NERIS has never accepted, and an unlocked one', async () => {
    mockContext({ incident: incident({ lockedAt: ALARM + 900 }), units: [], settings: settings() });
    expect((await call('./resubmitIncident.js', route)).json.code).toBe('NOT_IN_NERIS');

    vi.resetModules();
    mockReview();
    mockContext({ incident: incident({ nerisIncidentId }), units: [], settings: settings() });
    expect((await call('./resubmitIncident.js', route)).json.code).toBe('NOT_LOCKED');
  });

  it('queues a PUT-by-id with the field diff against what NERIS last accepted', async () => {
    mockContext({
      incident: incident({ nerisIncidentId, lockedAt: ALARM + 900, narrative: 'Corrected.' }),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    });
    review.getLastAcceptedPayload.mockResolvedValue({
      base: { outcome_narrative: 'Dumpster fire, knocked down.' },
    });
    review.enqueueResubmission.mockResolvedValue(undefined);
    const { statusCode, json } = await call('./resubmitIncident.js', route);

    expect(statusCode).toBe(202);
    expect(json).toMatchObject({ nerisIncidentId, status: 'QUEUED' });
    expect(json.diff).toEqual(
      expect.arrayContaining([
        {
          path: 'base.outcome_narrative',
          before: 'Dumpster fire, knocked down.',
          after: 'Corrected.',
        },
      ]),
    );
    expect(review.enqueueResubmission).toHaveBeenCalled();
  });

  it('does not resend an unchanged report', async () => {
    const context = {
      incident: incident({ nerisIncidentId, lockedAt: ALARM + 900 }),
      units: [COMPLETE_UNIT],
      settings: settings(),
      nerisApi: compiled,
    };
    mockContext(context);
    const { buildNerisIncidentPayload } = await import('./neris/payload.js');
    review.getLastAcceptedPayload.mockResolvedValue(
      buildNerisIncidentPayload({
        incident: context.incident as never,
        units: context.units,
        departmentNerisId: 'FD09190828',
        unitNerisIds: context.settings.unitNerisIds,
        schema: compiled as never,
      }),
    );
    const { statusCode, json } = await call('./resubmitIncident.js', route);
    expect(statusCode).toBe(200);
    expect(json).toMatchObject({ status: 'UNCHANGED', diff: [] });
    expect(review.enqueueResubmission).not.toHaveBeenCalled();
  });
});
