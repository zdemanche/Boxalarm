import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'mbr-102',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/alerting/self-test',
    rawPath: '/api/v1/alerting/self-test',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    body: undefined,
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
    createDynamoClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
    readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  }));
}

describe('selfTest postHandler', () => {
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
    vi.doUnmock('../dispatches/repository.js');
  });

  it('returns 403 and never creates a dispatch on Cedar deny (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    mockDynamoClient();
    const createManualDispatch = vi.fn();
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 403 });
    expect(createManualDispatch).not.toHaveBeenCalled();
  });

  it('returns 503 and never creates a dispatch when Verified Permissions is unavailable (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    mockDynamoClient();
    const createManualDispatch = vi.fn();
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    expect(createManualDispatch).not.toHaveBeenCalled();
  });

  it('returns 202 with a testId addressed only to the caller (targetMemberId=principal.sub) on success (AC1, entrypoint test)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    const createManualDispatch = vi.fn().mockResolvedValue({ outcome: 'created', dispatchId: 'NICHOLS-SELFTEST-1-abcd1234' });
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 202 });
    const body = JSON.parse((result as { body: string }).body) as {
      testId: string;
      status: string;
    };
    expect(body.status).toBe('RUNNING');
    expect(typeof body.testId).toBe('string');

    const input = createManualDispatch.mock.calls[0]?.[2] as {
      targetMemberId: string;
      channelsTested: string[];
      dispatch: { sourceSystem: string };
    };
    expect(input.targetMemberId).toBe('mbr-102');
    expect(input.dispatch.sourceSystem).toBe('SELF_TEST');
    expect(input.channelsTested).toEqual(['PUSH', 'SMS']);
  });

  it('returns 429 and never creates a dispatch when the per-member cooldown is still active (P1)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    vi.doMock('../eligibility/dynamoClient.js', () => ({
      createDynamoClient: vi.fn(() => ({
        send: vi.fn().mockRejectedValue(
          new ConditionalCheckFailedException({
            message: 'conditional check failed',
            $metadata: {},
          }),
        ),
      })),
      readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
    }));
    const createManualDispatch = vi.fn();
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 429 });
    expect(createManualDispatch).not.toHaveBeenCalled();
  });

  it('returns 429 and never upserts a RUNNING run when createManualDispatch reports an idempotency-key collision (P4 duplicate outcome)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    const createManualDispatch = vi.fn().mockResolvedValue({ outcome: 'duplicate' });
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 429 });
    errorSpy.mockRestore();
  });

  it('returns 503 and does not throw when DynamoDB is unavailable on create (AC-matrix)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    mockDynamoClient();
    const createManualDispatch = vi.fn().mockRejectedValue(new Error('Dynamo outage'));
    vi.doMock('../dispatches/repository.js', () => ({ createManualDispatch }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./postHandler.js');
    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('selfTest.post.createFailed'));
    errorSpy.mockRestore();
  });
});
