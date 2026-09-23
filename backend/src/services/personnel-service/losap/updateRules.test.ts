import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { getLosapPointRulesMock, putLosapPointRulesMock } = vi.hoisted(() => ({
  getLosapPointRulesMock: vi.fn(),
  putLosapPointRulesMock: vi.fn(),
}));

vi.mock('./configRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configRepository.js')>();
  return {
    ...actual,
    getLosapPointRules: getLosapPointRulesMock,
    putLosapPointRules: putLosapPointRulesMock,
  };
});

const { handler } = await import('./updateRules.js');
const { LosapConfigConflictError } = await import('./configRepository.js');

function buildEvent(
  groups: string,
  body: string | undefined,
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/losap/rules',
    rawPath: '/api/v1/personnel/losap/rules',
    rawQueryString: '',
    headers: {},
    ...(body !== undefined ? { body } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: '/api/v1/personnel/losap/rules',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/personnel/losap/rules',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': groups } },
    },
  };
}

describe('losap/updateRules handler (entrypoint test)', () => {
  beforeEach(() => {
    getLosapPointRulesMock.mockReset();
    putLosapPointRulesMock.mockReset();
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('saves a versioned rule set and mints a fresh ruleVersionId (AC1)', async () => {
    getLosapPointRulesMock.mockResolvedValueOnce(undefined);
    putLosapPointRulesMock.mockResolvedValueOnce({ ruleVersionId: 'RULE-2026', version: 1 });

    const result = await handler(
      buildEvent('ADMIN', JSON.stringify({ pointsByActivityType: { CALL: 2, DRILL: 1 } })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { ruleVersionId: string };
    expect(body.ruleVersionId).toBe('RULE-2026');
    expect(putLosapPointRulesMock).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-platform',
      'NICHOLS',
      { CALL: 2, DRILL: 1 },
      undefined,
      'actor-1',
      undefined,
    );
  });

  it('rejects a non-admin caller with 403 and never reaches the repository', async () => {
    const result = await handler(
      buildEvent('member', JSON.stringify({ pointsByActivityType: { CALL: 2 } })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(putLosapPointRulesMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body (bad activityType key)', async () => {
    const result = await handler(
      buildEvent('ADMIN', JSON.stringify({ pointsByActivityType: { BBQ: 2 } })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(putLosapPointRulesMock).not.toHaveBeenCalled();
  });

  it('returns 400 on a negative point value', async () => {
    const result = await handler(
      buildEvent('ADMIN', JSON.stringify({ pointsByActivityType: { CALL: -1 } })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 on an empty rules map', async () => {
    const result = await handler(
      buildEvent('ADMIN', JSON.stringify({ pointsByActivityType: {} })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 on a concurrent optimistic-lock version mismatch', async () => {
    getLosapPointRulesMock.mockResolvedValueOnce({
      ruleVersionId: 'RULE-2025',
      pointsByActivityType: { CALL: 1 },
      version: 2,
    });
    putLosapPointRulesMock.mockRejectedValueOnce(new LosapConfigConflictError());

    const result = await handler(
      buildEvent('ADMIN', JSON.stringify({ pointsByActivityType: { CALL: 2 } })),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });
});
