import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBER_AUTH, buildIncidentEvent, fakeCedarDecision } from './testEvents.js';

// putExposures is Cedar-gated (EditIncidentExposures): decide as the deployed NERIS tiers do.
const vpSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn(function () {
      return { send: vpSend };
    }),
  };
});

/**
 * A report locked for officer review rejects edits with 409 on every PUT route:
 *  - before any work, when the handler already loaded the locked row (update, exposures);
 *  - from the write itself, when the lock landed after the read — the repositories' METADATA
 *    condition fails and they throw IncidentLockedError (all four routes).
 */

const INCIDENT_ID = 'NICHOLS-4471-1798000000';
const LOCKED = {
  incidentId: INCIDENT_ID,
  deptId: 'NICHOLS',
  nerisSchemaVersion: '2026.2',
  corePayload: {},
  status: 'VALIDATED',
  lockedAt: 1_798_000_500,
  lockedBy: 'MBR-0034',
};

/** The same lock.js instance the handler under test loads (vi.resetModules gives each test a fresh registry). */
function lockModule(): Promise<typeof import('./lock.js')> {
  return import('./lock.js');
}

interface Result {
  readonly statusCode: number;
  readonly body: string;
}

async function invoke(file: string, routeKey: string, body: unknown): Promise<Result> {
  const { handler } = (await import(file)) as {
    handler: (event: unknown, context: unknown, cb: unknown) => Promise<Result>;
  };
  return handler(
    buildIncidentEvent({
      method: 'PUT',
      routeKey,
      auth: MEMBER_AUTH,
      incidentId: INCIDENT_ID,
      body,
    }),
    {},
    () => undefined,
  );
}

function expectLocked(result: Result): void {
  expect(result.statusCode).toBe(409);
  expect(JSON.parse(result.body)).toMatchObject({ status: 409, code: 'INCIDENT_LOCKED' });
}

function mockRepository(repository: Record<string, unknown>): void {
  vi.doMock('./repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./repository.js')>();
    return { ...actual, getIncidentRepository: () => repository };
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  vpSend.mockImplementation(fakeCedarDecision);
});

afterEach(() => {
  vi.doUnmock('./repository.js');
  vi.doUnmock('./responseUnitRepository.js');
  vi.doUnmock('./secondaryRepository.js');
  vi.restoreAllMocks();
});

describe('locked reports reject edits on every PUT route', () => {
  it('PUT /incidents/{id} (guided completion) — refused before validation or write', async () => {
    const updateCorePayload = vi.fn();
    mockRepository({ getIncident: () => Promise.resolve(LOCKED), updateCorePayload });
    expectLocked(
      await invoke('./updateIncident.js', 'PUT /api/v1/incidents/{incidentId}', {
        fields: { incident_type: 'STRUCTURE_FIRE' },
      }),
    );
    expect(updateCorePayload).not.toHaveBeenCalled();
  });

  it('PUT /incidents/{id}/narrative — the write condition refuses it', async () => {
    const { IncidentLockedError } = await lockModule();
    mockRepository({
      updateNarrative: () => Promise.reject(new IncidentLockedError(INCIDENT_ID)),
    });
    expectLocked(
      await invoke('./putNarrative.js', 'PUT /api/v1/incidents/{incidentId}/narrative', {
        narrative: 'late edit',
      }),
    );
  });

  it('PUT /incidents/{id}/response-times — the write condition refuses it', async () => {
    vi.doMock('./responseUnitRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./responseUnitRepository.js')>();
      return {
        ...actual,
        upsertResponseUnitTimes: async () => {
          throw new (await lockModule()).IncidentLockedError(INCIDENT_ID);
        },
      };
    });
    expectLocked(
      await invoke('./putResponseTimes.js', 'PUT /api/v1/incidents/{incidentId}/response-times', {
        unitId: 'E1',
        unitType: 'APPARATUS',
        arrivedAt: 1_798_000_400,
      }),
    );
  });

  it('PUT /incidents/{id}/exposures — refused before the schema lookup or write', async () => {
    const putIncidentSecondary = vi.fn();
    vi.doMock('./secondaryRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./secondaryRepository.js')>();
      return { ...actual, putIncidentSecondary };
    });
    mockRepository({ getIncident: () => Promise.resolve(LOCKED) });
    expectLocked(
      await invoke('./putExposures.js', 'PUT /api/v1/incidents/{incidentId}/exposures', {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: [],
      }),
    );
    expect(putIncidentSecondary).not.toHaveBeenCalled();
  });

  it('PUT /incidents/{id}/exposures — a lock that lands after the read still wins', async () => {
    vi.doMock('./secondaryRepository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./secondaryRepository.js')>();
      return {
        ...actual,
        // No module yet: a member creating their own exposure passes the M3 write rule and
        // reaches the write, where the late lock is what refuses it.
        getIncidentSecondary: () => Promise.resolve(undefined),
        putIncidentSecondary: async () => {
          throw new (await lockModule()).IncidentLockedError(INCIDENT_ID);
        },
      };
    });
    vi.doMock('./schemaVersion/repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./schemaVersion/repository.js')>();
      return {
        ...actual,
        createSchemaVersionRepository: () => ({
          getSchemaVersion: () => Promise.resolve({ version: '2026.2', secondarySchemaS3Key: 'k' }),
          getActiveSchemaVersion: () => Promise.resolve(undefined),
        }),
      };
    });
    vi.doMock('./schemaVersion/s3Schema.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./schemaVersion/s3Schema.js')>();
      return {
        ...actual,
        getSecondarySchemaDocument: () =>
          Promise.resolve({ version: '2026.2', requiredFieldsByType: {}, enumerationsByType: {} }),
      };
    });
    mockRepository({ getIncident: () => Promise.resolve({ ...LOCKED, lockedAt: undefined }) });
    const result = await invoke(
      './putExposures.js',
      'PUT /api/v1/incidents/{incidentId}/exposures',
      { secondaryType: 'EXPOSURE', payload: {}, affectedMemberIds: [MEMBER_AUTH.sub] },
    );
    vi.doUnmock('./schemaVersion/repository.js');
    vi.doUnmock('./schemaVersion/s3Schema.js');
    expectLocked(result);
  });
});
