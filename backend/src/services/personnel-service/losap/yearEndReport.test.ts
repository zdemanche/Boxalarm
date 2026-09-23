import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { listMembersMock } = vi.hoisted(() => ({ listMembersMock: vi.fn() }));
const { getYearEndReportMock } = vi.hoisted(() => ({ getYearEndReportMock: vi.fn() }));

vi.mock('../lib/memberRepository.js', () => ({ listMembers: listMembersMock }));
vi.mock('./repository.js', () => ({ getYearEndReport: getYearEndReportMock }));

const { handler } = await import('./yearEndReport.js');

function buildEvent(
  groups: string,
  year: string | undefined,
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/losap/year-end',
    rawPath: '/api/v1/personnel/losap/year-end',
    rawQueryString: year ? `year=${year}` : '',
    headers: {},
    ...(year ? { queryStringParameters: { year } } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/api/v1/personnel/losap/year-end',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/personnel/losap/year-end',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': groups } },
    },
  };
}

describe('losap/yearEndReport handler (entrypoint test)', () => {
  beforeEach(() => {
    listMembersMock.mockReset();
    getYearEndReportMock.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-personnel';
    process.env.PLATFORM_SERVICE_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('returns dept-wide per-member totals for an admin caller (AC4)', async () => {
    listMembersMock.mockResolvedValueOnce([{ memberId: 'mbr-1' }, { memberId: 'mbr-2' }]);
    getYearEndReportMock.mockResolvedValueOnce([
      { memberId: 'mbr-1', totalPoints: 4 },
      { memberId: 'mbr-2', totalPoints: 2 },
    ]);

    const result = await handler(buildEvent('ADMIN', '2026'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      year: number;
      members: unknown[];
    };
    expect(body.year).toBe(2026);
    expect(body.members).toHaveLength(2);
    expect(getYearEndReportMock).toHaveBeenCalledWith(
      expect.anything(),
      'boxalarm-dev-platform',
      'NICHOLS',
      ['mbr-1', 'mbr-2'],
      2026,
    );
  });

  it('rejects a non-admin caller with 403 and never reaches the repository', async () => {
    const result = await handler(buildEvent('member', '2026'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 403 });
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the year query parameter is missing or non-numeric', async () => {
    const missing = await handler(buildEvent('ADMIN', undefined), {} as never, () => undefined);
    const nonNumeric = await handler(buildEvent('ADMIN', 'abcd'), {} as never, () => undefined);

    expect(missing).toMatchObject({ statusCode: 400 });
    expect(nonNumeric).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 when the report repository is unavailable', async () => {
    listMembersMock.mockResolvedValueOnce([{ memberId: 'mbr-1' }]);
    getYearEndReportMock.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const result = await handler(buildEvent('ADMIN', '2026'), {} as never, () => undefined);

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
