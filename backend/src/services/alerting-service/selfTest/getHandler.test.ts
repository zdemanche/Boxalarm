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
        runAt: Math.floor(Date.now() / 1000),
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

  // Design review C3: the fan-out's publish leaves the run RUNNING; the GET decides it from the
  // channel workers' receipts the first time the member polls after they land.
  it("decides a RUNNING run from the workers' SENT receipts and records the verdict once", async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const nowMs = Date.now();
    const send = vi.fn(
      (command: { constructor: { name: string }; input: { Key: { sk: string } } }) =>
        Promise.resolve(
          command.constructor.name === 'GetCommand'
            ? { Item: { sendState: 'SENT', completedAtMs: nowMs - 500 } }
            : {},
        ),
    );
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({ send })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));
    const completeSelfTestRun = vi.fn().mockResolvedValue(true);
    vi.doMock('./selfTestRunRepository.js', () => ({
      SELF_TEST_METRIC_NAMESPACE: 'Boxalarm/AlertingSelfTest',
      completeSelfTestRun,
      getSelfTestRun: vi.fn().mockResolvedValue({
        testId: 't-1',
        runAt: Math.floor((nowMs - 2_000) / 1000),
        runAtMs: nowMs - 2_000,
        channelsTested: ['PUSH', 'SMS'],
        channelResults: {},
        overallResult: 'RUNNING',
        dispatchId: 'NICHOLS-SELFTEST-1',
        publishedChannels: ['PUSH', 'SMS'],
      }),
    }));

    const { handler } = await import('./getHandler.js');
    const result = await handler(buildEvent('t-1'));

    const body = JSON.parse((result as { body: string }).body) as {
      overallResult: string;
      channelResults: Record<string, { ok: boolean }>;
    };
    expect(body.overallResult).toBe('PASS');
    expect(body.channelResults).toMatchObject({ PUSH: { ok: true }, SMS: { ok: true } });
    expect(send.mock.calls.map(([command]) => command.input.Key.sk).sort()).toEqual([
      'RECEIPT#mbr-102#PUSH#1',
      'RECEIPT#mbr-102#SMS#1',
    ]);
    expect(completeSelfTestRun).toHaveBeenCalledWith(
      expect.anything(),
      'alerting-table',
      { deptId: 'NICHOLS', memberId: 'mbr-102', testId: 't-1' },
      expect.objectContaining({ overallResult: 'PASS' }),
    );
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
