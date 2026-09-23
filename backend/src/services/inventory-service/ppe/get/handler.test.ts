import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';

const MEMBER: CedarPrincipalContext = {
  sub: 'MBR-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(
  headers: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined,
  pathParameters: Record<string, string> | undefined,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/ppe/{memberId}',
    rawPath: '/api/v1/inventory/ppe/MBR-1',
    rawQueryString: '',
    headers,
    pathParameters,
    body: undefined,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(
  decision: 'ALLOW' | 'DENY',
): NonNullable<WithAuthorizationOptions['client']> {
  return {
    send: vi.fn().mockResolvedValue({ decision }),
  } as unknown as NonNullable<WithAuthorizationOptions['client']>;
}

function fakeDynamoClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('inventory ppe get handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 (fail-closed) for a request with no bearer token on the real exported handler (entrypoint)', async () => {
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined, MEMBER, { memberId: 'MBR-1' }));

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 when Cedar denies another member requesting a different memberId (AC4 self-service boundary)', async () => {
    const { createHandler } = await import('./handler.js');
    const testHandler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await testHandler(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-other' }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('rejects a missing memberId path param with 400', async () => {
    const { createGetPpeHandler } = await import('./handler.js');
    const inner = createGetPpeHandler(fakeDynamoClient(vi.fn()));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, undefined),
      MEMBER,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 and [] for a member with zero PPE items', async () => {
    const { createGetPpeHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({});
    const inner = createGetPpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-1' }),
      MEMBER,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([]);
  });

  it('returns the assignment with status ISSUED (AC1)', async () => {
    const { createGetPpeHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          ppeItemId: 'TURNOUT-COAT',
          memberId: 'MBR-1',
          itemType: 'TURNOUT_COAT',
          size: '44R',
          issueDate: '2026-01-10',
          nfpaExpiryDate: '2036-01-10',
          status: 'ISSUED',
        },
      ],
    });
    const inner = createGetPpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-1' }),
      MEMBER,
    );

    const body = JSON.parse((result as { body: string }).body) as { status: string }[];
    expect(body[0]?.status).toBe('ISSUED');
  });

  it('shows status EXPIRED, not ISSUED, once nfpaExpiryDate has passed (AC3, core-harm)', async () => {
    const { createGetPpeHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          ppeItemId: 'TURNOUT-COAT',
          memberId: 'MBR-1',
          itemType: 'TURNOUT_COAT',
          size: '44R',
          issueDate: '2014-01-10',
          nfpaExpiryDate: '2024-01-10',
          status: 'ISSUED',
        },
      ],
    });
    const inner = createGetPpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-1' }),
      MEMBER,
    );

    const body = JSON.parse((result as { body: string }).body) as { status: string }[];
    expect(body[0]?.status).toBe('EXPIRED');
  });

  it('returns 503, logs the original error, on an unexpected DynamoDB failure (fail-closed)', async () => {
    const { createGetPpeHandler } = await import('./handler.js');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const inner = createGetPpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-1' }),
      MEMBER,
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
