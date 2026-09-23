import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';

const ADMIN: CedarPrincipalContext = {
  sub: 'admin-1',
  deptId: 'dept-001',
  'cognito:groups': 'admin',
};
const MEMBER: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
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
    routeKey: 'PUT /api/v1/inventory/equipment/{assetId}/lifecycle',
    rawPath: '/api/v1/inventory/equipment/AS-0055/lifecycle',
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

function fakeDynamoClient(handlers: {
  get?: () => Promise<{ Item?: Record<string, unknown> }>;
  update?: () => Promise<unknown>;
}): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return (handlers.get ?? (() => Promise.resolve({})))();
      }
      if (command.constructor.name === 'UpdateCommand') {
        return (handlers.update ?? (() => Promise.resolve({})))();
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    }),
  } as unknown as DynamoDBDocumentClient;
}

describe('inventory lifecycle handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects a request with no bearer token on the real exported handler, before any dependency is touched (entrypoint)', async () => {
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(undefined, ADMIN, { assetId: 'AS-0055' }, undefined));

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('rejects a non-admin principal (AC3)', async () => {
    const { createHandler } = await import('./handler.js');
    const testHandler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await testHandler(
      buildEvent(
        { authorization: 'Bearer token' },
        MEMBER,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('rejects a missing/invalid lifecycleStatus body with a 400 RFC 7807 problem', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(fakeDynamoClient({}));

    const missing = await inner(
      buildEvent({ authorization: 'Bearer token' }, ADMIN, { assetId: 'AS-0055' }, undefined),
      ADMIN,
    );
    const wrongType = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 7 }),
      ),
      ADMIN,
    );
    const unknownEnum = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'DECOMMISSIONED' }),
      ),
      ADMIN,
    );

    for (const result of [missing, wrongType, unknownEnum]) {
      expect(result).toMatchObject({ statusCode: 400 });
      const body = JSON.parse((result as { body: string }).body) as { type: string };
      expect(body.type).toBe('https://boxalarm.dev/problems/invalid-lifecycle-request');
    }
  });

  it('rejects an assetId containing the pk delimiter "#" with a 400, not a 503 (fail-closed input validation)', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(fakeDynamoClient({}));

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS#0055' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { type: string };
    expect(body.type).toBe('https://boxalarm.dev/problems/invalid-lifecycle-request');
  });

  it('returns 409, not a crash, when the stored lifecycleStatus is not a recognized enum member', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(
      fakeDynamoClient({
        get: () => Promise.resolve({ Item: { lifecycleStatus: 'DECOMMISSIONED' } }),
      }),
    );

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 404 when the asset does not exist', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(fakeDynamoClient({ get: () => Promise.resolve({}) }));

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-missing' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 for an invalid transition such as RETIRED to IN_SERVICE', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(
      fakeDynamoClient({ get: () => Promise.resolve({ Item: { lifecycleStatus: 'RETIRED' } }) }),
    );

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('records the transition and returns 200 on a valid admin transition (AC2)', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(
      fakeDynamoClient({ get: () => Promise.resolve({ Item: { lifecycleStatus: 'IN_SERVICE' } }) }),
    );

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'RETIRED' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { lifecycleStatus: string };
    expect(body.lifecycleStatus).toBe('RETIRED');
  });

  it('returns 409, not a silent write, when the transition loses a concurrent-update race', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(
      fakeDynamoClient({
        get: () => Promise.resolve({ Item: { lifecycleStatus: 'IN_SERVICE' } }),
        update: () => {
          throw new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} });
        },
      }),
    );

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'RETIRED' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 503, never a defaulted transition, when DynamoDB is unavailable (core-harm, fail-closed)', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inner = createLifecycleHandler(
      fakeDynamoClient({
        get: () => {
          throw new Error('ProvisionedThroughputExceededException');
        },
      }),
    );

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        { assetId: 'AS-0055' },
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(logSpy).toHaveBeenCalled();
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.reason).toBe('Error');
    logSpy.mockRestore();
  });

  it('createLifecycleHandler in isolation rejects no assetId path parameter with a 400, not a crash (defense-in-depth)', async () => {
    const { createLifecycleHandler } = await import('./handler.js');
    const inner = createLifecycleHandler(fakeDynamoClient({}));

    const result = await inner(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        undefined,
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
      ADMIN,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503, not a 403, on the exported handler when no assetId path parameter is present and the authz client rejects the empty resourceId (fail-closed, matches guard.ts AuthzUnavailableError handling)', async () => {
    const { createHandler } = await import('./handler.js');
    const rejectingAuthzClient = {
      send: vi.fn().mockRejectedValue(new Error('ValidationException: entityId must not be empty')),
    } as unknown as NonNullable<WithAuthorizationOptions['client']>;
    const testHandler = createHandler({
      authzClient: rejectingAuthzClient,
      dynamoClient: fakeDynamoClient({}),
    });

    const result = await testHandler(
      buildEvent(
        { authorization: 'Bearer token' },
        ADMIN,
        undefined,
        JSON.stringify({ lifecycleStatus: 'IN_SERVICE' }),
      ),
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
