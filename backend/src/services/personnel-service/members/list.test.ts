import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { listMembersMock } = vi.hoisted(() => ({ listMembersMock: vi.fn() }));

vi.mock('../lib/memberRepository.js', () => ({
  listMembers: listMembersMock,
}));

const { handler } = await import('./list.js');

function buildEvent(): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/personnel/members',
    rawPath: '/api/v1/personnel/members',
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
        path: '/api/v1/personnel/members',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /api/v1/personnel/members',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  };
}

describe('members/list handler (entrypoint test)', () => {
  beforeEach(() => {
    listMembersMock.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('returns 200 with contact, status, joinDate, rank, and agencyId for every member scoped to the department (AC4)', async () => {
    listMembersMock.mockResolvedValueOnce([
      {
        memberId: 'm1',
        deptId: 'NICHOLS',
        phone: '203-555-0100',
        email: 'jamie@example.com',
        status: 'ACTIVE',
        joinDate: '2026-01-01',
        rank: 'FIREFIGHTER',
        agencyId: 'NFD-0099',
      },
    ]);
    const result = await handler(buildEvent(), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 200 });
    const parsed = JSON.parse((result as { body: string }).body) as {
      members: Array<Record<string, unknown>>;
    };
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]).toMatchObject({
      phone: '203-555-0100',
      email: 'jamie@example.com',
      status: 'ACTIVE',
      joinDate: '2026-01-01',
      rank: 'FIREFIGHTER',
      agencyId: 'NFD-0099',
    });
  });

  it('returns 200 with an empty list when the department has no members', async () => {
    listMembersMock.mockResolvedValueOnce([]);
    const result = await handler(buildEvent(), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ members: [] });
  });

  it('returns 503 and logs the original error when the DynamoDB Query fails (fail-closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listMembersMock.mockRejectedValueOnce(new Error('Query throttled'));
    const result = await handler(buildEvent(), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Query throttled'));
  });
});
