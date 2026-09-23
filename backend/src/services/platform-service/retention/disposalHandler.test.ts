import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const DEPT_ID = 'NICHOLS';

const ADMIN: CedarPrincipalContext = {
  sub: 'MBR-0012',
  deptId: DEPT_ID,
  'cognito:groups': 'ADMIN',
};

function buildEvent(
  routeKey: string,
  principal: CedarPrincipalContext | undefined,
  body?: string,
): GuardEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/platform/retention/disposal',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    isBase64Encoded: false,
    body,
    requestContext: {
      authorizer: { lambda: principal },
    },
  } as unknown as GuardEvent;
}

function fakeDocClient(sendImpl: (command: unknown) => unknown = () => ({})) {
  return { send: vi.fn(sendImpl) } as never;
}

function fakeKmsClient(sendImpl: (command: unknown) => unknown = () => ({})) {
  return { send: vi.fn(sendImpl) } as never;
}

function mockVerifiedPermissions(sendImpl: () => Promise<{ decision: string }>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vi.fn(sendImpl) })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

function mockVerifiedPermissionsOutage(): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockRejectedValue(new Error('VP outage')),
    })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

describe('disposalHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.restoreAllMocks();
  });

  it('returns 403 for non-admin denied by the Cedar policy, without any step-up challenge path', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(),
      kmsClient: fakeKmsClient(),
    });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        { ...ADMIN, 'cognito:groups': 'OFFICER' },
        JSON.stringify({ candidates: [] }),
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(403);
    const problem = JSON.parse(result.body) as { title: string; traceId: string };
    expect(problem.title).toBe('Forbidden');
    expect(typeof problem.traceId).toBe('string');
  });

  it('denies an absent authorizer context/bearer token (fail-secure, no step-up path)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(),
      kmsClient: fakeKmsClient(),
    });

    const result = (await handler(
      buildEvent('POST /api/v1/platform/retention/disposal', undefined),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(403);
  });

  it('returns 503 and never touches DynamoDB/KMS when Verified Permissions is unavailable', async () => {
    mockVerifiedPermissionsOutage();
    const send = vi.fn();
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(send),
      kmsClient: fakeKmsClient(send),
    });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        ADMIN,
        JSON.stringify({ candidates: [] }),
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts CHIEF/ADMIN allowed by the Cedar policy and returns disposal summary', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({});
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(send),
      kmsClient: fakeKmsClient(),
    });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        { ...ADMIN, 'cognito:groups': 'CHIEF' },
        JSON.stringify({ candidates: [] }),
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      hardDeleted: 0,
      cryptoShredded: 0,
      refused: [],
    });
  });

  it('returns 400 when candidates exceeds the length cap', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const send = vi.fn().mockResolvedValue({});
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(send),
      kmsClient: fakeKmsClient(),
    });

    const tooMany = Array.from({ length: 501 }, (_, i) => ({
      pk: `DEPT#${DEPT_ID}#X`,
      sk: `${i}`,
    }));
    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        ADMIN,
        JSON.stringify({ candidates: tooMany }),
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
