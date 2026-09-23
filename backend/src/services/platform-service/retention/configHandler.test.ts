import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';

const DEPT_ID = 'NICHOLS';
const VERIFIED_DEPT_ID = toVerifiedDeptId({ deptId: DEPT_ID });

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
    rawPath: '/api/v1/platform/retention',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    isBase64Encoded: false,
    body,
    requestContext: {
      authorizer: { lambda: principal },
    },
  } as unknown as GuardEvent;
}

function fakeDocClient(sendImpl: (command: unknown) => unknown) {
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

describe('retention configHandler', () => {
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

  it('denies an absent authorizer context/bearer token (fail-secure, no step-up path)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { handler } = await import('./configHandler.js');
    const result = (await handler(buildEvent('GET /api/v1/platform/retention', undefined))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body) as { title: string; traceId: string };
    expect(body.title).toBe('Forbidden');
    expect(body.traceId).toEqual(expect.any(String));
  });

  it('returns 403 for a non-admin/chief caller denied by the Cedar policy (no step-up path)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });
    const result = (await handler(
      buildEvent('GET /api/v1/platform/retention', { ...ADMIN, 'cognito:groups': 'MEMBER' }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({ title: 'Forbidden' });
  });

  it('returns 503 and never touches the repository when Verified Permissions is unavailable', async () => {
    mockVerifiedPermissionsOutage();
    const send = vi.fn();
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(send) });
    const result = (await handler(buildEvent('GET /api/v1/platform/retention', ADMIN))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it('PUT stores retentionYears under CONFIG#RETENTION for CHIEF/ADMIN (AC1)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const send = vi.fn().mockResolvedValue({});
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(send) });

    const result = (await handler(
      buildEvent(
        'PUT /api/v1/platform/retention',
        { ...ADMIN, 'cognito:groups': 'CHIEF' },
        JSON.stringify({ retentionYears: 10 }),
      ),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      configType: 'RETENTION',
      value: { retentionYears: 10 },
      version: 1,
    });
    const put = send.mock.calls.find((call) => call[0] instanceof PutCommand)?.[0] as PutCommand;
    expect(put.input.Item).toMatchObject({
      pk: buildDeptScopedPk(VERIFIED_DEPT_ID),
      sk: 'CONFIG#RETENTION',
      entityType: 'DEPARTMENT_CONFIG',
      configType: 'RETENTION',
      value: { retentionYears: 10 },
    });
  });

  it('GET returns the stored retention config for an ADMIN', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: `DEPT#${DEPT_ID}`,
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears: 5 },
        version: 2,
      },
    });
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(send) });

    const result = (await handler(buildEvent('GET /api/v1/platform/retention', ADMIN))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      retentionYears: 5,
      version: 2,
      source: 'stored',
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it('GET returns default 7 years when no config is stored', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });

    const result = (await handler(buildEvent('GET /api/v1/platform/retention', ADMIN))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      retentionYears: 7,
      source: 'default',
    });
  });

  it('PUT returns 400 when retentionYears is missing or invalid', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });

    const result = (await handler(
      buildEvent('PUT /api/v1/platform/retention', ADMIN, JSON.stringify({ retentionYears: 0 })),
    )) as { statusCode: number };

    expect(result.statusCode).toBe(400);
  });

  it('PUT returns 409 when a concurrent write already advanced the version', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          pk: `DEPT#${DEPT_ID}`,
          sk: 'CONFIG#RETENTION',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'RETENTION',
          value: { retentionYears: 7 },
          version: 2,
        },
      })
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        }),
      );
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(send) });

    const result = (await handler(
      buildEvent('PUT /api/v1/platform/retention', ADMIN, JSON.stringify({ retentionYears: 12 })),
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(409);
  });
});
