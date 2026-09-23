import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApparatusEvent } from './authContext.js';

function buildEvent(lambdaContext: Record<string, unknown> | undefined): ApparatusEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus',
    rawPath: '/api/v1/apparatus',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/apparatus',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/apparatus',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as ApparatusEvent;
}

const VALID_AUTH_CONTEXT = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' };

describe('listApparatus handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./apparatusRepository.js');
    vi.restoreAllMocks();
  });

  it('returns 200 with the department-scoped apparatus list', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      getApparatusRepository: () => ({
        listApparatus: vi.fn().mockResolvedValue([
          {
            apparatusId: 'APP-ENGINE-2',
            unitId: 'ENGINE-2',
            type: 'ENGINE',
            status: 'IN_SERVICE',
          },
        ]),
      }),
    }));
    const { handler } = await import('./listApparatus.js');

    const result = await handler(buildEvent(VALID_AUTH_CONTEXT), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      apparatus: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
    });
  });

  it('returns 401 problem+json when the authorizer context is missing', async () => {
    const { handler } = await import('./listApparatus.js');

    const result = await handler(buildEvent(undefined), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
    const body = JSON.parse((result as { body: string }).body) as { traceId: string };
    expect(body.traceId).toBeTruthy();
  });

  it('returns 503 problem+json (fail-closed) when DynamoDB is unavailable', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      getApparatusRepository: () => ({
        listApparatus: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
      }),
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./listApparatus.js');

    const result = await handler(buildEvent(VALID_AUTH_CONTEXT), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
  });
});
