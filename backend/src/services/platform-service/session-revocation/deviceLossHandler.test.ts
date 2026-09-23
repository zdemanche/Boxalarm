import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { AuthorizerContext } from '../authorizer/handler.js';

function buildEvent(
  groups: string,
  body: string | undefined,
  deptId = 'dept-001',
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/platform/sessions/revoke',
    rawPath: '/api/v1/platform/sessions/revoke',
    rawQueryString: '',
    headers: {},
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: '111122223333',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/api/v1/platform/sessions/revoke',
        protocol: 'HTTP/1.1',
        sourceIp: '10.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /api/v1/platform/sessions/revoke',
      stage: '$default',
      time: '14/Sep/2026:00:00:00 +0000',
      timeEpoch: 0,
      authorizer: {
        lambda: { sub: 'admin-1', deptId, 'cognito:groups': groups },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

function mockRevocationClient(overrides: {
  revokeMemberSession?: ReturnType<typeof vi.fn>;
  resolveMemberDeptId?: ReturnType<typeof vi.fn>;
}): void {
  vi.doMock('./cognitoRevocationClient.js', () => ({
    readRevocationConfig: () => ({ userPoolId: 'pool-1' }),
    createRevocationClient: () => ({}),
    revokeMemberSession: overrides.revokeMemberSession ?? vi.fn(),
    resolveMemberDeptId: overrides.resolveMemberDeptId ?? vi.fn().mockResolvedValue('dept-001'),
  }));
}

describe('deviceLossHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.COGNITO_USER_POOL_ID = 'pool-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./cognitoRevocationClient.js');
    vi.restoreAllMocks();
  });

  it('denies (403, fail-secure) when the caller has no CHIEF/ADMIN group', async () => {
    const revokeMemberSession = vi.fn();
    mockRevocationClient({ revokeMemberSession });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('officer', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('denies (403, fail-secure) when cognito:groups is empty', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
  });

  it('returns 400 when memberId is absent', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({})),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when memberId is an empty string', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('ADMIN', JSON.stringify({ memberId: '' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when memberId is wrong-typed (number)', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('ADMIN', JSON.stringify({ memberId: 12345 })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when the body is absent', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('ADMIN', undefined),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
  });

  it('calls Cognito revocation and returns 202 for an authorized CHIEF caller (entrypoint)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockRevocationClient({ revokeMemberSession });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(202);
    expect(revokeMemberSession).toHaveBeenCalledWith(
      {},
      { userPoolId: 'pool-1', username: 'mbr-102', correlationId: expect.any(String) as string },
    );
  });

  it('returns 404 when memberId names an unknown Cognito user', async () => {
    mockRevocationClient({
      resolveMemberDeptId: vi
        .fn()
        .mockRejectedValue(new UserNotFoundException({ message: 'no such user', $metadata: {} })),
    });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('ADMIN', JSON.stringify({ memberId: 'mbr-ghost' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
  });

  it('returns 503 (fail-closed) when the Cognito API is unavailable/throttled', async () => {
    mockRevocationClient({
      revokeMemberSession: vi.fn().mockRejectedValue(new Error('throttled')),
    });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(503);
  });

  it('returns 403 when a CHIEF in one department targets a member in another department', async () => {
    const revokeMemberSession = vi.fn();
    mockRevocationClient({
      revokeMemberSession,
      resolveMemberDeptId: vi.fn().mockResolvedValue('dept-002'),
    });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-other-dept' }), 'dept-001'),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('returns 403 (fail closed) when the target member department cannot be resolved', async () => {
    const revokeMemberSession = vi.fn();
    mockRevocationClient({
      revokeMemberSession,
      resolveMemberDeptId: vi.fn().mockResolvedValue(undefined),
    });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-unresolved' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(403);
    expect(revokeMemberSession).not.toHaveBeenCalled();
  });

  it('returns 500 with a traceId when session revocation is misconfigured', async () => {
    vi.doMock('./cognitoRevocationClient.js', () => ({
      readRevocationConfig: () => {
        throw new Error('COGNITO_USER_POOL_ID is required and was not set');
      },
      createRevocationClient: () => ({}),
      revokeMemberSession: vi.fn(),
      resolveMemberDeptId: vi.fn(),
    }));
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(500);
    const parsed = JSON.parse(result.body ?? '{}') as { traceId?: string };
    expect(parsed.traceId).toBeTruthy();
  });

  it('never re-prompts for a second factor — a valid CHIEF session alone is sufficient (AC3)', async () => {
    const revokeMemberSession = vi.fn().mockResolvedValue(undefined);
    mockRevocationClient({ revokeMemberSession });
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('CHIEF', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(202);
    expect(JSON.stringify(result)).not.toMatch(/mfa|otp|challenge|step-?up/i);
  });

  it('includes a traceId in the RFC 7807 error body (house convention)', async () => {
    mockRevocationClient({});
    const { handler } = await import('./deviceLossHandler.js');

    const result = (await handler(
      buildEvent('officer', JSON.stringify({ memberId: 'mbr-102' })),
      {} as never,
      () => undefined,
    )) as APIGatewayProxyStructuredResultV2;

    const parsed = JSON.parse(result.body ?? '{}') as { traceId?: string; type?: string };
    expect(parsed.traceId).toBeTruthy();
    expect(parsed.type).toBe('about:blank');
  });
});
