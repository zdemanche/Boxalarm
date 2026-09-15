import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';

const ADMIN: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'admin',
};
const MEMBER: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(
  headers: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined,
  pathParameters: Record<string, string> | undefined,
  body: string | undefined,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inventory/ppe/{memberId}',
    rawPath: '/api/v1/inventory/ppe/MBR-1',
    rawQueryString: '',
    headers,
    pathParameters,
    body,
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

const VALID_BODY = JSON.stringify({
  itemType: 'TURNOUT_COAT',
  size: '44R',
  issueDate: '2026-01-10',
});

describe('inventory ppe issue handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects a request with no bearer token on the real exported handler (entrypoint)', async () => {
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined, ADMIN, { memberId: 'MBR-1' }, VALID_BODY));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('rejects a non-admin principal via Cedar deny (403)', async () => {
    const { createHandler } = await import('./handler.js');
    const testHandler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await testHandler(
      buildEvent({ authorization: 'Bearer token' }, MEMBER, { memberId: 'MBR-1' }, VALID_BODY),
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503, never a defaulted allow, when Verified Permissions is unavailable', async () => {
    const { createHandler } = await import('./handler.js');
    const rejectingClient = {
      send: vi.fn().mockRejectedValue(new Error('AuthzUnavailable')),
    } as unknown as NonNullable<WithAuthorizationOptions['client']>;
    const testHandler = createHandler({ authzClient: rejectingClient });

    const result = await testHandler(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { memberId: 'MBR-1' }, VALID_BODY),
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('rejects a missing memberId path param with 400', async () => {
    const { createIssuePpeHandler } = await import('./handler.js');
    const inner = createIssuePpeHandler(fakeDynamoClient(vi.fn()));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, undefined, VALID_BODY),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it.each([
    ['missing itemType', JSON.stringify({ size: '44R', issueDate: '2026-01-10' })],
    ['missing size', JSON.stringify({ itemType: 'TURNOUT_COAT', issueDate: '2026-01-10' })],
    [
      'non-ISO issueDate',
      JSON.stringify({ itemType: 'TURNOUT_COAT', size: '44R', issueDate: '01/10/2026' }),
    ],
    [
      'future issueDate',
      JSON.stringify({ itemType: 'TURNOUT_COAT', size: '44R', issueDate: '2099-01-01' }),
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const { createIssuePpeHandler } = await import('./handler.js');
    const inner = createIssuePpeHandler(fakeDynamoClient(vi.fn()));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { memberId: 'MBR-1' }, body),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const parsedBody = JSON.parse((result as { body: string }).body) as { type: string };
    expect(parsedBody.type).toBe('https://boxalarm.dev/problems/invalid-ppe-request');
  });

  it('returns 409 when the itemType is already issued to the member', async () => {
    const { createIssuePpeHandler } = await import('./handler.js');
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    const inner = createIssuePpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { memberId: 'MBR-1' }, VALID_BODY),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('persists the assignment and returns 201 with nfpaExpiryDate and status ISSUED (AC1)', async () => {
    const { createIssuePpeHandler } = await import('./handler.js');
    const send = vi.fn().mockResolvedValue({});
    const inner = createIssuePpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { memberId: 'MBR-1' }, VALID_BODY),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as {
      nfpaExpiryDate: string;
      status: string;
    };
    expect(body.nfpaExpiryDate).toBe('2036-01-10');
    expect(body.status).toBe('ISSUED');
  });

  it('returns 503, logs the original error, on an unexpected DynamoDB failure (fail-closed)', async () => {
    const { createIssuePpeHandler } = await import('./handler.js');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const inner = createIssuePpeHandler(fakeDynamoClient(send));

    const result = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { memberId: 'MBR-1' }, VALID_BODY),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'inventory.ppe.issue.error');
    expect(logged?.reason).toBe('Error');
    logSpy.mockRestore();
  });
});
