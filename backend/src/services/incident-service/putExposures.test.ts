import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import { bearerFor, fakeCedarDecision } from './testEvents.js';

const vpSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn(() => ({ send: vpSend })),
  };
});
import { SECONDARY_SCHEMA_V_N, SECONDARY_SCHEMA_V_N_MINUS_1 } from './schemaVersion/fixtures.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
  pathParameters: Record<string, string> = { incidentId: 'NICHOLS-4471-1798000000' },
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/incidents/{incidentId}/exposures',
    rawPath: '/api/v1/incidents/NICHOLS-4471-1798000000/exposures',
    rawQueryString: '',
    headers: bearerFor(lambdaContext),
    pathParameters,
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: '/api/v1/incidents/NICHOLS-4471-1798000000/exposures',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/incidents/{incidentId}/exposures',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };
const OFFICER_AUTH = { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER OFFICER' };

const BASE_INCIDENT = {
  incidentId: 'NICHOLS-4471-1798000000',
  deptId: 'NICHOLS',
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: {},
  status: 'DRAFT',
  createdBy: 'MBR-0034',
};

function mockDeps(
  overrides: {
    readonly putIncidentSecondary?: ReturnType<typeof vi.fn>;
    readonly getIncidentSecondary?: ReturnType<typeof vi.fn>;
    readonly getIncident?: ReturnType<typeof vi.fn>;
    readonly getSchemaVersion?: ReturnType<typeof vi.fn>;
    readonly getSecondarySchemaDocument?: ReturnType<typeof vi.fn>;
  } = {},
): void {
  process.env.INCIDENT_TABLE_NAME = 'boxalarm-dev-incident';
  vi.doMock('./repository.js', () => ({
    IncidentNotFoundError: class IncidentNotFoundError extends Error {},
    getDocumentClient: () => ({}),
    getTableName: () => 'boxalarm-dev-incident',
    getIncidentRepository: () => ({
      getIncident: overrides.getIncident ?? vi.fn().mockResolvedValue(BASE_INCIDENT),
    }),
  }));
  vi.doMock('./secondaryRepository.js', async (importOriginal) => ({
    SecondaryConflictError: (await importOriginal<typeof import('./secondaryRepository.js')>())
      .SecondaryConflictError,
    putIncidentSecondary: overrides.putIncidentSecondary ?? vi.fn().mockResolvedValue(1),
    getIncidentSecondary: overrides.getIncidentSecondary ?? vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./schemaVersion/repository.js', () => ({
    createSchemaVersionRepository: () => ({
      getActiveSchemaVersion: vi.fn().mockResolvedValue({
        version: '2026.2',
        secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
      }),
      getSchemaVersion:
        overrides.getSchemaVersion ??
        vi.fn().mockResolvedValue({
          version: '2026.2',
          secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
        }),
    }),
  }));
  vi.doMock('./schemaVersion/s3Schema.js', () => ({
    getSecondarySchemaDocument:
      overrides.getSecondarySchemaDocument ?? vi.fn().mockResolvedValue(SECONDARY_SCHEMA_V_N),
  }));
  vi.doMock('../platform-service/export/awsClients.js', () => ({ getS3Client: () => ({}) }));
}

describe('putExposures handler', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    vpSend.mockImplementation(fakeCedarDecision);
  });

  afterEach(() => {
    vi.doUnmock('./repository.js');
    vi.doUnmock('./secondaryRepository.js');
    vi.doUnmock('./schemaVersion/repository.js');
    vi.doUnmock('./schemaVersion/s3Schema.js');
    vi.doUnmock('../platform-service/export/awsClients.js');
    vi.restoreAllMocks();
  });

  it('creates an INCIDENT_SECONDARY record naming the affected members (E6-S6 AC1)', async () => {
    const putIncidentSecondary = vi.fn().mockResolvedValue(undefined);
    mockDeps({ putIncidentSecondary });
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(putIncidentSecondary).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-incident',
      'NICHOLS',
      expect.objectContaining({ secondaryType: 'EXPOSURE', affectedMemberIds: ['MBR-0034'] }),
      'req-1',
      { previous: undefined, actorId: 'MBR-0001' },
    );
  });

  it('rejects a value outside the Secondary schema enumeration before completion (AC2)', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'RADIATION' },
        affectedMemberIds: ['MBR-0034'],
      }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.field).toBe('exposure_type');
    expect(body.errors[0]?.message).toMatch(/must be one of/);
  });

  it(
    'validates an older incident against its own pinned (SUPERSEDED) Secondary schema version, ' +
      'not the newer ACTIVE schema (regression for PR #316 CRITICAL finding)',
    async () => {
      const olderIncident = { ...BASE_INCIDENT, nerisSchemaVersion: '2026.1' };
      const getSchemaVersion = vi.fn().mockImplementation((version: string) =>
        Promise.resolve(
          version === '2026.1'
            ? {
                version: '2026.1',
                status: 'SUPERSEDED',
                secondarySchemaS3Key: 'neris-schema/2026.1/secondary.json',
              }
            : undefined,
        ),
      );
      const getSecondarySchemaDocument = vi
        .fn()
        .mockImplementation((_s3: unknown, _bucket: unknown, key: string) =>
          Promise.resolve(
            key === 'neris-schema/2026.1/secondary.json'
              ? SECONDARY_SCHEMA_V_N_MINUS_1
              : SECONDARY_SCHEMA_V_N,
          ),
        );
      mockDeps({
        getIncident: vi.fn().mockResolvedValue(olderIncident),
        getSchemaVersion,
        getSecondarySchemaDocument,
      });
      const { handler } = await import('./putExposures.js');

      // BLOODBORNE is valid under the newer ACTIVE (2026.2) Secondary schema but NOT under
      // this incident's own pinned 2026.1 schema — proving it validates against the pinned
      // version, not whatever is ACTIVE now.
      const result = await handler(
        buildEvent(OFFICER_AUTH, {
          secondaryType: 'EXPOSURE',
          payload: { exposure_type: 'BLOODBORNE' },
          affectedMemberIds: ['MBR-0034'],
        }),
      );

      expect(getSchemaVersion).toHaveBeenCalledWith('2026.1');
      expect(result).toMatchObject({ statusCode: 400 });
      const body = JSON.parse((result as { body: string }).body) as {
        errors: { field: string; message: string }[];
      };
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]?.field).toBe('exposure_type');
    },
  );

  it('returns 404 when the incident does not exist', async () => {
    mockDeps({ getIncident: vi.fn().mockResolvedValue(undefined) });
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(OFFICER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
      }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when affectedMemberIds is missing', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { secondaryType: 'EXPOSURE', payload: {} }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(undefined, { secondaryType: 'EXPOSURE', payload: {}, affectedMemberIds: [] }),
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });

  // Review M3: any member could overwrite or erase an exposure record naming a colleague.
  describe('write authorization and concurrency (M3)', () => {
    const EXISTING = {
      incidentId: 'NICHOLS-4471-1798000000',
      secondaryType: 'EXPOSURE',
      payload: { exposure_type: 'SMOKE' },
      affectedMemberIds: ['MBR-0034', 'MBR-0099'],
      updatedAt: 10,
      version: 3,
    };

    async function put(auth: Record<string, unknown>, body: Record<string, unknown>) {
      const { handler } = await import('./putExposures.js');
      return (await handler(
        buildEvent(auth, {
          secondaryType: 'EXPOSURE',
          payload: { exposure_type: 'SMOKE' },
          ...body,
        }),
      )) as { statusCode: number; body: string };
    }

    it('refuses a member erasing the colleagues an existing record names (the review scenario)', async () => {
      const putIncidentSecondary = vi.fn();
      mockDeps({ putIncidentSecondary, getIncidentSecondary: vi.fn().mockResolvedValue(EXISTING) });

      const result = await put(MEMBER_AUTH, { affectedMemberIds: [] });

      expect(result.statusCode).toBe(403);
      expect(putIncidentSecondary).not.toHaveBeenCalled();
    });

    it('refuses a member who is not named on the record', async () => {
      const putIncidentSecondary = vi.fn();
      mockDeps({
        putIncidentSecondary,
        getIncidentSecondary: vi
          .fn()
          .mockResolvedValue({ ...EXISTING, affectedMemberIds: ['MBR-0034'] }),
      });

      const result = await put(MEMBER_AUTH, { affectedMemberIds: ['MBR-0034'] });

      expect(result.statusCode).toBe(403);
      expect(putIncidentSecondary).not.toHaveBeenCalled();
    });

    it('lets a named member update the payload while the named set stays the same', async () => {
      const putIncidentSecondary = vi.fn().mockResolvedValue(4);
      mockDeps({ putIncidentSecondary, getIncidentSecondary: vi.fn().mockResolvedValue(EXISTING) });

      const result = await put(MEMBER_AUTH, { affectedMemberIds: ['MBR-0099', 'MBR-0034'] });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ version: 4 });
      expect(putIncidentSecondary).toHaveBeenCalledWith(
        expect.anything(),
        'boxalarm-dev-incident',
        'NICHOLS',
        expect.anything(),
        'req-1',
        { previous: EXISTING, actorId: 'MBR-0099' },
      );
    });

    it('lets a member create a module naming only themselves, and nobody else', async () => {
      mockDeps();
      expect((await put(MEMBER_AUTH, { affectedMemberIds: ['MBR-0099'] })).statusCode).toBe(200);

      vi.resetModules();
      mockDeps();
      expect(
        (await put(MEMBER_AUTH, { affectedMemberIds: ['MBR-0099', 'MBR-0034'] })).statusCode,
      ).toBe(403);
    });

    it('lets an officer rewrite who a record names', async () => {
      mockDeps({ getIncidentSecondary: vi.fn().mockResolvedValue(EXISTING) });

      expect((await put(OFFICER_AUTH, { affectedMemberIds: ['MBR-0034'] })).statusCode).toBe(200);
    });

    it('answers 409 when the client read an older version than is stored', async () => {
      const putIncidentSecondary = vi.fn();
      mockDeps({ putIncidentSecondary, getIncidentSecondary: vi.fn().mockResolvedValue(EXISTING) });

      const result = await put(OFFICER_AUTH, {
        affectedMemberIds: ['MBR-0034'],
        expectedVersion: 2,
      });

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({ currentVersion: 3 });
      expect(putIncidentSecondary).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent write wins between the read and the write', async () => {
      const putIncidentSecondary = vi.fn();
      mockDeps({ getIncidentSecondary: vi.fn().mockResolvedValue(EXISTING), putIncidentSecondary });
      // The class the handler will load (the mocked module re-exports the real one).
      const { SecondaryConflictError } = await import('./secondaryRepository.js');
      putIncidentSecondary.mockRejectedValue(
        new SecondaryConflictError('NICHOLS-4471-1798000000', 'EXPOSURE'),
      );

      expect((await put(OFFICER_AUTH, { affectedMemberIds: ['MBR-0034'] })).statusCode).toBe(409);
    });

    it('rejects a malformed expectedVersion', async () => {
      mockDeps();

      expect(
        (await put(OFFICER_AUTH, { affectedMemberIds: ['MBR-0034'], expectedVersion: 'x' }))
          .statusCode,
      ).toBe(400);
    });
  });
});
