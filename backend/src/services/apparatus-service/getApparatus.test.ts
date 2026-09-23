import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApparatusEvent } from './authContext.js';

function buildEvent(
  lambdaContext: Record<string, unknown> | undefined,
  unitId: string | undefined,
): ApparatusEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/{unitId}',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}`,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: `/api/v1/apparatus/${unitId ?? ''}`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/apparatus/{unitId}',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as ApparatusEvent;
}

const VALID_AUTH_CONTEXT = { sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' };

describe('getApparatus handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unmock('./apparatusRepository.js');
    vi.restoreAllMocks();
  });

  it('returns 200 with the apparatus detail, incl. open defects and failed tests (AC3)', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      getApparatusRepository: () => ({
        getApparatusDetail: vi.fn().mockResolvedValue({
          apparatusId: 'APP-ENGINE-2',
          unitId: 'ENGINE-2',
          type: 'ENGINE',
          status: 'IN_SERVICE',
          openDefects: [
            {
              defectId: 'DEF-1',
              description: 'Low tire pressure',
              severity: 'MINOR',
              reportedAt: 1798050000,
            },
          ],
          failedTests: [{ testType: 'HOSE', testDate: '2026-05-01', nextDueDate: '2027-05-01' }],
        }),
      }),
    }));
    const { handler } = await import('./getApparatus.js');

    const result = await handler(
      buildEvent(VALID_AUTH_CONTEXT, 'ENGINE-2'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      apparatusId: 'APP-ENGINE-2',
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
      openDefects: [
        {
          defectId: 'DEF-1',
          description: 'Low tire pressure',
          severity: 'MINOR',
          reportedAt: 1798050000,
        },
      ],
      failedTests: [{ testType: 'HOSE', testDate: '2026-05-01', nextDueDate: '2027-05-01' }],
    });
  });

  it('returns 200 with empty openDefects/failedTests when there are none', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      getApparatusRepository: () => ({
        getApparatusDetail: vi.fn().mockResolvedValue({
          apparatusId: 'APP-ENGINE-2',
          unitId: 'ENGINE-2',
          type: 'ENGINE',
          status: 'IN_SERVICE',
          openDefects: [],
          failedTests: [],
        }),
      }),
    }));
    const { handler } = await import('./getApparatus.js');

    const result = await handler(
      buildEvent(VALID_AUTH_CONTEXT, 'ENGINE-2'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      openDefects: unknown[];
      failedTests: unknown[];
    };
    expect(body.openDefects).toEqual([]);
    expect(body.failedTests).toEqual([]);
  });

  it('returns 404 problem+json when no apparatus matches the unitId', async () => {
    vi.doMock('./apparatusRepository.js', () => ({
      getApparatusRepository: () => ({
        getApparatusDetail: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    const { handler } = await import('./getApparatus.js');

    const result = await handler(
      buildEvent(VALID_AUTH_CONTEXT, 'ENGINE-9'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 401 problem+json when the authorizer context is missing', async () => {
    const { handler } = await import('./getApparatus.js');

    const result = await handler(buildEvent(undefined, 'ENGINE-2'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 problem+json when the unitId path parameter is missing', async () => {
    const { handler } = await import('./getApparatus.js');

    const result = await handler(
      buildEvent(VALID_AUTH_CONTEXT, undefined),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
