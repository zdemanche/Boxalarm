import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  queryStringParameters: Record<string, string> | undefined,
): IncidentEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/incidents',
    rawPath: '/api/v1/incidents',
    rawQueryString: '',
    headers: {},
    queryStringParameters,
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/incidents',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/incidents',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as IncidentEvent;
}

const MEMBER_AUTH = { sub: 'MBR-0099', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' };

describe('searchIncidents handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./repository.js');
    vi.restoreAllMocks();
  });

  it('returns only incidents in the given alarm-time range, with summary fields on each row (AC1/AC3)', async () => {
    const searchIncidents = vi.fn().mockResolvedValue([
      {
        incidentId: 'A',
        incidentType: 'STRUCTURE_FIRE',
        address: '1 Main St',
        alarmAt: 1000,
        status: 'DRAFT',
      },
    ]);
    vi.doMock('./repository.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./repository.js')>();
      return { ...actual, getIncidentRepository: () => ({ searchIncidents }) };
    });
    const { handler } = await import('./searchIncidents.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { fromAlarmAt: '500', toAlarmAt: '2000' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(searchIncidents).toHaveBeenCalledWith('NICHOLS', { fromAlarmAt: 500, toAlarmAt: 2000 });
    const body = JSON.parse((result as { body: string }).body) as { incidents: unknown[] };
    expect(body.incidents).toEqual([
      {
        incidentId: 'A',
        incidentType: 'STRUCTURE_FIRE',
        address: '1 Main St',
        alarmAt: 1000,
        status: 'DRAFT',
      },
    ]);
  });

  it('returns 400 when fromAlarmAt is missing', async () => {
    const { handler } = await import('./searchIncidents.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { toAlarmAt: '2000' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when fromAlarmAt is after toAlarmAt', async () => {
    const { handler } = await import('./searchIncidents.js');

    const result = await handler(
      buildEvent(MEMBER_AUTH, { fromAlarmAt: '2000', toAlarmAt: '500' }),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 401 when unauthorized', async () => {
    const { handler } = await import('./searchIncidents.js');

    const result = await handler(buildEvent(undefined, {}), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });
});
