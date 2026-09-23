import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(testId: string | undefined): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/alerting/self-test/{testId}',
    rawPath: `/api/v1/alerting/self-test/${testId ?? ''}`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: testId ? { testId } : undefined,
    requestContext: { authorizer: { lambda: PRINCIPAL } },
  } as unknown as GuardEvent;
}

function mockVerifiedPermissions(sendImpl: () => Promise<{ decision: string }>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vi.fn(sendImpl) })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

function mockDynamoClient(): void {
  vi.doMock('../eligibility/dynamoClient.js', () => ({
    createDynamoClient: vi.fn(() => ({})),
    readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  }));
}

describe('selfTest getHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.doUnmock('./selfTestRunRepository.js');
  });

  it('returns 403 on Cedar deny (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    mockDynamoClient();

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('1798000000'));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    mockDynamoClient();

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 404 for an unknown/foreign testId (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./selfTestRunRepository.js', () => ({
      getSelfTestRun: vi.fn().mockResolvedValue(undefined),
    }));

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('unknown'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 404 when testId path parameter is absent', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 200 with per-channel outcome, timestamp-bearing run and specific reasons — not a bare ok (AC2/AC5, entrypoint test)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./selfTestRunRepository.js', () => ({
      getSelfTestRun: vi.fn().mockResolvedValue({
        testId: '1798000000',
        runAt: 1798000000,
        channelsTested: ['PUSH', 'SMS'],
        channelResults: {
          PUSH: { ok: false, ms: 12, reason: 'push: no token registered' },
          SMS: { ok: true, ms: 88 },
        },
        overallResult: 'FAIL',
      }),
    }));

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      channelResults: Record<string, { ok: boolean; ms: number; reason?: string }>;
      overallResult: string;
      runAt: number;
    };
    expect(body.overallResult).toBe('FAIL');
    expect(body.runAt).toBe(1798000000);
    expect(body.channelResults.PUSH).toEqual({
      ok: false,
      ms: 12,
      reason: 'push: no token registered',
    });
    expect(body.channelResults.SMS?.ok).toBe(true);
  });

  it('returns 200 with overallResult RUNNING immediately after POST, before fan-out has landed a verdict (P8)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./selfTestRunRepository.js', () => ({
      getSelfTestRun: vi.fn().mockResolvedValue({
        testId: '1798000000',
        runAt: 1798000000,
        channelsTested: ['PUSH', 'SMS'],
        channelResults: {},
        overallResult: 'RUNNING',
      }),
    }));

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('1798000000'));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { overallResult: string };
    expect(body.overallResult).toBe('RUNNING');
  });

  it('returns 503 and does not throw when DynamoDB is unavailable on read (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    vi.doMock('./selfTestRunRepository.js', () => ({
      getSelfTestRun: vi.fn().mockRejectedValue(new Error('Dynamo outage')),
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('1798000000'));

    expect(result).toMatchObject({ statusCode: 503 });
    errorSpy.mockRestore();
  });
});
