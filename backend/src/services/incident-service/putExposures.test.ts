import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';
import { SECONDARY_SCHEMA_V_N } from './schemaVersion/fixtures.js';

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
    headers: {},
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

function mockDeps(
  overrides: { readonly putIncidentSecondary?: ReturnType<typeof vi.fn> } = {},
): void {
  process.env.INCIDENT_TABLE_NAME = 'boxalarm-dev-incident';
  vi.doMock('./repository.js', () => ({
    getDocumentClient: () => ({}),
    getTableName: () => 'boxalarm-dev-incident',
  }));
  vi.doMock('./secondaryRepository.js', () => ({
    putIncidentSecondary: overrides.putIncidentSecondary ?? vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./schemaVersion/repository.js', () => ({
    createSchemaVersionRepository: () => ({
      getActiveSchemaVersion: vi.fn().mockResolvedValue({
        version: '2026.2',
        secondarySchemaS3Key: 'neris-schema/2026.2/secondary.json',
      }),
    }),
  }));
  vi.doMock('./schemaVersion/s3Schema.js', () => ({
    getSecondarySchemaDocument: vi.fn().mockResolvedValue(SECONDARY_SCHEMA_V_N),
  }));
  vi.doMock('../platform-service/export/awsClients.js', () => ({ getS3Client: () => ({}) }));
}

describe('putExposures handler', () => {
  beforeEach(() => {
    vi.resetModules();
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
      buildEvent(MEMBER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'SMOKE' },
        affectedMemberIds: ['MBR-0034'],
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(putIncidentSecondary).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-incident',
      'NICHOLS',
      expect.objectContaining({ secondaryType: 'EXPOSURE', affectedMemberIds: ['MBR-0034'] }),
    );
  });

  it('rejects a value outside the Secondary schema enumeration before completion (AC2)', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, {
        secondaryType: 'EXPOSURE',
        payload: { exposure_type: 'RADIATION' },
        affectedMemberIds: ['MBR-0034'],
      }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as {
      errors: { field: string; message: string }[];
    };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.field).toBe('exposure_type');
    expect(body.errors[0]?.message).toMatch(/must be one of/);
  });

  it('returns 400 when affectedMemberIds is missing', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { secondaryType: 'EXPOSURE', payload: {} }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    mockDeps();
    const { handler } = await import('./putExposures.js');

    const result = await handler(
      buildEvent(undefined, { secondaryType: 'EXPOSURE', payload: {}, affectedMemberIds: [] }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
