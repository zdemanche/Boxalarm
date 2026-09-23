import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { getMemberMock } = vi.hoisted(() => ({ getMemberMock: vi.fn() }));

vi.mock('../lib/memberRepository.js', () => ({
  getMember: getMemberMock,
}));

const { handler } = await import('./get.js');

function buildEvent(
  memberId: string | undefined,
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/members/{memberId}',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}`,
    rawQueryString: '',
    headers: {},
    ...(memberId ? { pathParameters: { memberId } } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: `/api/v1/personnel/members/${memberId ?? ''}`,
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/personnel/members/{memberId}',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  };
}

describe('members/get handler (entrypoint test)', () => {
  beforeEach(() => {
    getMemberMock.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('returns 200 with the member on a hit (AC1)', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    const result = await handler(buildEvent('m1'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ memberId: 'm1' });
  });

  it('returns 404 for an unknown memberId', async () => {
    getMemberMock.mockResolvedValueOnce(undefined);
    const result = await handler(buildEvent('missing'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when memberId path parameter is absent', async () => {
    const result = await handler(buildEvent(undefined), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
    expect(getMemberMock).not.toHaveBeenCalled();
  });

  it('returns 503 and logs the original error on a repository failure (fail-closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMemberMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await handler(buildEvent('m1'), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
  });
});
