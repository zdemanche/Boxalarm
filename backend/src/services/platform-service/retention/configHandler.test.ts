import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../authorizer/handler.js';

const DEPT_ID = 'NICHOLS';
const VERIFIED_DEPT_ID = toVerifiedDeptId({ deptId: DEPT_ID });

function buildEvent(
  routeKey: string,
  context: Partial<AuthorizerContext> | undefined,
  body?: string,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/platform/retention',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    ...(body !== undefined ? { body } : {}),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: routeKey.split(' ')[0] ?? 'GET',
        path: '/api/v1/platform/retention',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey,
      stage: '$default',
      time: '1/1/2026',
      timeEpoch: Date.now(),
      authorizer: { lambda: context as AuthorizerContext },
    },
  };
}

function adminContext(overrides: Partial<AuthorizerContext> = {}): AuthorizerContext {
  return { sub: 'MBR-0012', deptId: DEPT_ID, 'cognito:groups': 'ADMIN', ...overrides };
}

function fakeDocClient(sendImpl: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl) } as never;
}

describe('retention configHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('is exported as the real Lambda entrypoint and denies an absent authorizer context', async () => {
    const { handler } = await import('./configHandler.js');
    const result = (await handler(
      buildEvent('GET /api/v1/platform/retention', undefined),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body) as { traceId: string };
    expect(body.traceId).toEqual(expect.any(String));
  });

  it('returns 403 for a non-admin/chief caller (no step-up path)', async () => {
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });
    const result = (await handler(
      buildEvent('GET /api/v1/platform/retention', adminContext({ 'cognito:groups': 'MEMBER' })),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({
      title: 'Forbidden',
      status: 403,
      detail: 'CHIEF or ADMIN role is required.',
    });
  });

  it('PUT stores retentionYears under CONFIG#RETENTION for CHIEF/ADMIN (AC1)', async () => {
    const { createHandler } = await import('./configHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ docClient: fakeDocClient(send) });

    const result = (await handler(
      buildEvent(
        'PUT /api/v1/platform/retention',
        adminContext({ 'cognito:groups': 'CHIEF' }),
        JSON.stringify({ retentionYears: 10 }),
      ),
      {} as never,
      () => undefined,
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
    const { createHandler } = await import('./configHandler.js');
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
    const handler = createHandler({ docClient: fakeDocClient(send) });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/retention', adminContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      retentionYears: 5,
      version: 2,
      source: 'stored',
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it('GET returns default 7 years when no config is stored', async () => {
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });

    const result = (await handler(
      buildEvent('GET /api/v1/platform/retention', adminContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      retentionYears: 7,
      source: 'default',
    });
  });

  it('PUT returns 400 when retentionYears is missing or invalid', async () => {
    const { createHandler } = await import('./configHandler.js');
    const handler = createHandler({ docClient: fakeDocClient(() => ({})) });

    const result = (await handler(
      buildEvent(
        'PUT /api/v1/platform/retention',
        adminContext(),
        JSON.stringify({ retentionYears: 0 }),
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number };

    expect(result.statusCode).toBe(400);
  });
});
