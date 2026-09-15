import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

const { getMemberMock, updateMemberStatusMock } = vi.hoisted(() => ({
  getMemberMock: vi.fn(),
  updateMemberStatusMock: vi.fn(),
}));

vi.mock('../lib/memberRepository.js', () => ({
  getMember: getMemberMock,
  updateMemberStatus: updateMemberStatusMock,
}));

const { handler } = await import('./updateStatus.js');

function buildEvent(
  memberId: string | undefined,
  body: string | undefined,
  groups: string,
): APIGatewayProxyEventV2WithLambdaAuthorizer<VerifiedAccessToken> {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/personnel/members/{memberId}/status',
    rawPath: `/api/v1/personnel/members/${memberId ?? ''}/status`,
    rawQueryString: '',
    headers: {},
    ...(body !== undefined ? { body } : {}),
    ...(memberId ? { pathParameters: { memberId } } : {}),
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: `/api/v1/personnel/members/${memberId ?? ''}/status`,
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /api/v1/personnel/members/{memberId}/status',
      stage: '$default',
      time: '2026-01-01T00:00:00Z',
      timeEpoch: 0,
      authorizer: { lambda: { sub: 'actor-1', deptId: 'NICHOLS', 'cognito:groups': groups } },
    },
  };
}

describe('members/updateStatus handler (entrypoint test)', () => {
  beforeEach(() => {
    getMemberMock.mockReset();
    updateMemberStatusMock.mockReset();
    process.env.PERSONNEL_TABLE_NAME = 'boxalarm-dev-platform';
  });

  it('updates status, writes audit trail, and returns 200 for an admin caller (AC2)', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    updateMemberStatusMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(updateMemberStatusMock).toHaveBeenCalledWith(
      'boxalarm-dev-platform',
      expect.objectContaining({ sub: 'actor-1' }),
      'm1',
      'PROBATIONARY',
      'ACTIVE',
      'actor-1',
    );
  });

  it('rejects a non-admin caller with 403 and never reaches the repository (AC3, core-harm)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'MEMBER'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(getMemberMock).not.toHaveBeenCalled();
    expect(updateMemberStatusMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('member.status.update.forbidden'),
    );
  });

  it('rejects an illegal transition out of the terminal RETIRED status with 409', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'RETIRED' });
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 409 });
    expect(updateMemberStatusMock).not.toHaveBeenCalled();
  });

  it('rejects an absent status field with 400', async () => {
    const result = await handler(
      buildEvent('m1', JSON.stringify({}), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a status value outside MEMBER_STATUSES with 400', async () => {
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'DELETED' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for an unknown memberId', async () => {
    getMemberMock.mockResolvedValueOnce(undefined);
    const result = await handler(
      buildEvent('missing', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 and logs the original error, with no partial write, when TransactWriteItems fails (fail-closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    updateMemberStatusMock.mockRejectedValueOnce(new Error('TransactionCanceledException'));
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('TransactionCanceledException'));
  });

  it('returns 409 when the write fails a conditional check from a concurrent status change (P10)', async () => {
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    const error = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    });
    updateMemberStatusMock.mockRejectedValueOnce(error);
    const result = await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('emits a MemberStatusUpdated business metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getMemberMock.mockResolvedValueOnce({ memberId: 'm1', status: 'PROBATIONARY' });
    updateMemberStatusMock.mockResolvedValueOnce({ updatedAt: 1, eventId: 'evt-1' });
    await handler(
      buildEvent('m1', JSON.stringify({ status: 'ACTIVE' }), 'ADMIN'),
      {} as never,
      () => undefined,
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MemberStatusUpdated'));
  });
});
