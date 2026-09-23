import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  incidentId: string | undefined,
  headers: Record<string, string> = {},
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/incidents/{incidentId}',
    rawPath: `/api/v1/incidents/${incidentId ?? ''}`,
    rawQueryString: '',
    headers,
    isBase64Encoded: false,
    pathParameters: incidentId !== undefined ? { incidentId } : undefined,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: `/api/v1/incidents/${incidentId ?? ''}`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/incidents/{incidentId}',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

describe('getIncident handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  it('returns 200 with incident detail for an authenticated caller', async () => {
    vi.doMock('./repository.js', () => ({
      getIncidentRepository: () => ({
        getIncident: vi.fn().mockResolvedValue({
          incidentId: 'NICHOLS-4471-1798000000',
          nerisSchemaVersion: '2026.2',
          corePayload: { opaque: true },
          status: 'DRAFT',
        }),
      }),
    }));
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, 'NICHOLS-4471-1798000000'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({
      incidentId: 'NICHOLS-4471-1798000000',
      nerisSchemaVersion: '2026.2',
      status: 'DRAFT',
    });
  });

  it('returns 404 when no incident matches', async () => {
    vi.doMock('./repository.js', () => ({
      getIncidentRepository: () => ({
        getIncident: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, 'NICHOLS-9999-1'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(undefined, 'NICHOLS-4471-1798000000'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 when incidentId path parameter is missing', async () => {
    const { handler } = await import('./getIncident.js');

    const result = await handler(buildEvent(MEMBER_AUTH, undefined), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 (not 503, and does not touch the repository) when incidentId contains a # delimiter (regression for PR #149 finding 2)', async () => {
    const getIncident = vi.fn();
    vi.doMock('./repository.js', () => ({
      getIncidentRepository: () => ({ getIncident }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, 'abc#METADATA'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(getIncident).not.toHaveBeenCalled();
  });

  it('uses the caller W3C traceparent header as the problem-body traceId (regression for PR #149 finding 3)', async () => {
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(undefined, 'NICHOLS-4471-1798000000', {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
      {} as never,
      () => undefined,
    );

    const body = JSON.parse((result as { body: string }).body) as Record<string, unknown>;
    expect(body.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('returns 503 when DynamoDB is unavailable', async () => {
    vi.doMock('./repository.js', () => ({
      getIncidentRepository: () => ({
        getIncident: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
      }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./getIncident.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, 'NICHOLS-4471-1798000000'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
