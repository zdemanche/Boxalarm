import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';

const DEPT_ID = 'NICHOLS';

function buildEvent(
  routeKey: string,
  context: Partial<AuthorizerContext> | undefined,
  body?: string,
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/api/v1/platform/retention/disposal',
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
        method: routeKey.split(' ')[0] ?? 'POST',
        path: '/api/v1/platform/retention/disposal',
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

function fakeDocClient(sendImpl: (command: unknown) => unknown = () => ({})) {
  return { send: vi.fn(sendImpl) } as never;
}

function fakeKmsClient(sendImpl: (command: unknown) => unknown = () => ({})) {
  return { send: vi.fn(sendImpl) } as never;
}

describe('disposalHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns 403 for non-admin without any step-up challenge path', async () => {
    const { createHandler } = await import('./disposalHandler.js');
    const handler = createHandler({
      docClient: fakeDocClient(),
      kmsClient: fakeKmsClient(),
    });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        adminContext({ 'cognito:groups': 'OFFICER' }),
        JSON.stringify({ candidates: [] }),
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(403);
    const problem = JSON.parse(result.body) as {
      title: string;
      status: number;
      detail: string;
      traceId: string;
    };
    expect(problem).toMatchObject({
      title: 'Forbidden',
      status: 403,
      detail: 'CHIEF or ADMIN role is required.',
    });
    expect(typeof problem.traceId).toBe('string');
  });

  it('accepts CHIEF/ADMIN and returns disposal summary with problem+json wiring on auth failure only', async () => {
    const { createHandler } = await import('./disposalHandler.js');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      docClient: fakeDocClient(send),
      kmsClient: fakeKmsClient(),
    });

    const result = (await handler(
      buildEvent(
        'POST /api/v1/platform/retention/disposal',
        adminContext({ 'cognito:groups': 'CHIEF' }),
        JSON.stringify({ candidates: [] }),
      ),
      {} as never,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      hardDeleted: 0,
      cryptoShredded: 0,
      refused: [],
    });
  });
});
