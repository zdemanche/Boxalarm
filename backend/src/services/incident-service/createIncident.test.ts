import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  body: unknown,
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/incidents',
    rawPath: '/api/v1/incidents',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/incidents',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/incidents',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const ADMIN_AUTH = { sub: 'MBR-0034', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };
const CHIEF_AUTH = { sub: 'MBR-0001', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' };
const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

const VALID_BODY = {
  dispatchNumber: '4471',
  epochSeconds: 1_798_000_000,
  nerisSchemaVersion: '2026.2',
  corePayload: { opaque: true },
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
};

describe('createIncident handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  it('returns 201 with NERIS-format incidentId equal to sourceDispatchId for ADMIN (AC3)', async () => {
    const createIncident = vi.fn().mockImplementation((_deptId, input) =>
      Promise.resolve({
        incidentId: 'NICHOLS-4471-1798000000',
        sourceDispatchId: 'NICHOLS-4471-1798000000',
        deptId: 'NICHOLS',
        status: 'DRAFT',
        ...input,
      }),
    );
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.incidentId).toBe('NICHOLS-4471-1798000000');
    expect(body.sourceDispatchId).toBe(body.incidentId);
    expect(createIncident).toHaveBeenCalledWith(
      'NICHOLS',
      expect.objectContaining({
        dispatchNumber: '4471',
        epochSeconds: 1_798_000_000,
        nerisSchemaVersion: '2026.2',
        corePayload: { opaque: true },
        createdBy: 'MBR-0034',
        status: 'DRAFT',
      }),
      expect.any(Number),
    );
  });

  it('allows CHIEF to create an incident', async () => {
    const createIncident = vi.fn().mockResolvedValue({
      incidentId: 'NICHOLS-4471-1798000000',
      status: 'DRAFT',
    });
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(CHIEF_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('never derives deptId from the request body (core-harm)', async () => {
    const createIncident = vi.fn().mockResolvedValue({ incidentId: 'NICHOLS-4471-1798000000' });
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ createIncident }) };
    });
    const { handler } = await import('./createIncident.js');

    await handler(
      buildEvent(ADMIN_AUTH, { ...VALID_BODY, deptId: 'FORGED-DEPT' }),
      {} as never,
      () => undefined,
    );

    expect(createIncident).toHaveBeenCalledWith('NICHOLS', expect.any(Object), expect.any(Number));
  });

  it('returns 403 for a non-admin caller', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(MEMBER_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(undefined, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 when corePayload is missing', async () => {
    const { handler } = await import('./createIncident.js');
    const rest = Object.fromEntries(
      Object.entries(VALID_BODY).filter(([key]) => key !== 'corePayload'),
    );

    const result = await handler(buildEvent(ADMIN_AUTH, rest), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when status is an unknown enum value (AC4)', async () => {
    const { handler } = await import('./createIncident.js');

    const result = await handler(
      buildEvent(ADMIN_AUTH, { ...VALID_BODY, status: 'OPEN' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 on duplicate incidentId', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          createIncident: vi
            .fn()
            .mockRejectedValue(new actual.DuplicateIncidentError('NICHOLS-4471-1798000000')),
        }),
      };
    });
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503 when DynamoDB is unavailable', async () => {
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return {
        ...actual,
        getIncidentRepository: () => ({
          createIncident: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
        }),
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./createIncident.js');

    const result = await handler(buildEvent(ADMIN_AUTH, VALID_BODY), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
