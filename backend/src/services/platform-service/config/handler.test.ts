import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { createConfigCache } from './cache.js';

const DEPT_ID = 'nichols';

function buildEvent(
  method: 'GET' | 'PUT',
  configType: string,
  context: Partial<AuthorizerContext> | undefined,
  body?: unknown,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  const path = `/api/v1/platform/config/${configType}`;
  return {
    version: '2.0',
    routeKey: `${method} /api/v1/platform/config/{configType}`,
    rawPath: path,
    rawQueryString: '',
    headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
    isBase64Encoded: false,
    pathParameters: { configType },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: `${method} /api/v1/platform/config/{configType}`,
      stage: '$default',
      time: '1/1/2026',
      timeEpoch: Date.now(),
      authorizer: { lambda: context as AuthorizerContext },
    },
  };
}

function memberContext(overrides: Partial<AuthorizerContext> = {}): AuthorizerContext {
  return {
    sub: 'member-0012',
    deptId: DEPT_ID,
    'cognito:groups': 'MEMBER',
    ...overrides,
  };
}

function adminContext(overrides: Partial<AuthorizerContext> = {}): AuthorizerContext {
  return {
    sub: 'member-0099',
    deptId: DEPT_ID,
    'cognito:groups': 'ADMIN',
    ...overrides,
  };
}

function fakeDocClient(sendImpl: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl) } as never;
}

describe('department config handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('GET returns 200 with the stored config for an authenticated member', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: `DEPT#${DEPT_ID}`,
        sk: 'CONFIG#ALERT_RULES',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'ALERT_RULES',
        value: { escalationThresholdN: 3 },
        version: 2,
        updatedAt: '2026-09-15T00:00:00.000Z',
        updatedBy: 'admin-1',
      },
    });
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });

    const result = (await handler(
      buildEvent('GET', 'ALERT_RULES', memberContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 3 },
      version: 2,
    });
  });

  it('GET returns 404 when the config type has never been written', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({
      docClient: fakeDocClient(() => ({})),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent('GET', 'STATIONS', memberContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('PUT rejects a non-admin with 403 and does not write', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn();
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent('PUT', 'ALERT_RULES', memberContext(), {
        value: { escalationThresholdN: 4 },
        expectedVersion: 1,
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('PUT persists config for an ADMIN without a step-up challenge and returns the new version', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent('PUT', 'CHECKLIST_DEFAULTS', adminContext(), {
        value: { items: [{ code: 'OIL', label: 'Check oil', requiresPhoto: false }] },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      configType: 'CHECKLIST_DEFAULTS',
      version: 1,
      value: { items: [{ code: 'OIL', label: 'Check oil', requiresPhoto: false }] },
    });
  });

  it('PUT returns 400 with field-level errors when body.value does not match the configType schema', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn();
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent('PUT', 'ALERT_RULES', adminContext(), {
        // Arbitrary JSON with no recognized ALERT_RULES fields — this is the
        // exact shape PR #145 accepted with zero validation (E8-S4 review round 2).
        value: { arbitraryEscalationOverride: { disableAll: true } },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    const body = JSON.parse(result.body) as {
      errors?: readonly { field: string; message: string }[];
    };
    expect(body.errors).toContainEqual({
      field: 'arbitraryEscalationOverride',
      message: 'is not a recognized field',
    });
  });

  it('PUT returns 400 with field-level errors for a malformed RETENTION value', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn();
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent('PUT', 'RETENTION', adminContext(), {
        value: { retentionYears: -1 },
      }),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    const body = JSON.parse(result.body) as {
      errors?: readonly { field: string; message: string }[];
    };
    expect(body.errors).toContainEqual({
      field: 'retentionYears',
      message: 'is required and must be a positive integer',
    });
  });

  it('PUT returns 409 when two admins race on the same expectedVersion', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'conflict',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({ ttlMs: 60_000 }),
    });
    const result = (await handler(
      buildEvent(
        'PUT',
        'ALERT_RULES',
        { ...adminContext(), 'cognito:groups': 'CHIEF' },
        {
          value: { escalationThresholdN: 9 },
          expectedVersion: 2,
        },
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number; headers?: Record<string, string> };
    expect(result.statusCode).toBe(409);
    expect(result.headers?.['content-type']).toBe('application/problem+json');
  });

  it('GET still succeeds when the cache store is down by falling back to DynamoDB', async () => {
    const { createHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: `DEPT#${DEPT_ID}`,
        sk: 'CONFIG#RANKS',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RANKS',
        value: { ranks: ['FF'] },
        version: 1,
        updatedAt: '2026-09-15T00:00:00.000Z',
        updatedBy: 'admin-1',
      },
    });
    const handler = createHandler({
      docClient: fakeDocClient(send),
      cache: createConfigCache({
        ttlMs: 60_000,
        store: {
          get() {
            throw new Error('valkey down');
          },
          set() {
            throw new Error('valkey down');
          },
          delete() {
            /* ignore */
          },
        },
      }),
    });
    const result = (await handler(
      buildEvent('GET', 'RANKS', memberContext()),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { value: { ranks: string[] } };
    expect(body.value).toEqual({ ranks: ['FF'] });
  });
});
