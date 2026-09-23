import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';

const MEMBER: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'NICHOLS',
  'cognito:groups': '',
};

function buildEvent(
  principal: Partial<CedarPrincipalContext> | null | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer test-token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inventory/consumables',
    rawPath: '/api/v1/inventory/consumables',
    rawQueryString: '',
    headers,
    requestContext: {
      requestId: 'req-1',
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

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

describe('handler (GET /api/v1/inventory/consumables, entrypoint-test)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 401 (fail-closed) for a request with no bearer token on the real exported handler, before any dependency is touched (readiness/authz gate)', async () => {
    const { handler } = await import('./handler.js');

    const result = await handler(buildEvent(MEMBER, {}));

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 when Verified Permissions denies the ListConsumables action', async () => {
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('DENY') });

    const result = await handler(buildEvent(MEMBER));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('AC1: returns 200 with items at/below threshold flagged distinctly from adequate stock', async () => {
    const client = fakeDocClient((command) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return {
        Items: [
          {
            pk: 'DEPT#NICHOLS#CONSUMABLE#GLOVES-L',
            sk: 'METADATA',
            entityType: 'CONSUMABLE_STOCK',
            itemName: 'Gloves (Large)',
            stockLevel: 3,
            reorderThreshold: 5,
          },
          {
            pk: 'DEPT#NICHOLS#CONSUMABLE#STRAPS-M',
            sk: 'METADATA',
            entityType: 'CONSUMABLE_STOCK',
            itemName: 'Straps (Medium)',
            stockLevel: 20,
            reorderThreshold: 5,
          },
        ],
      };
    });
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), dynamoClient: client });

    const result = await handler(buildEvent(MEMBER));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      items: { itemId: string; reorderFlagged: boolean }[];
    };
    expect(body.items.find((item) => item.itemId === 'GLOVES-L')?.reorderFlagged).toBe(true);
    expect(body.items.find((item) => item.itemId === 'STRAPS-M')?.reorderFlagged).toBe(false);
  });

  it('AC1: returns 200 with an empty list for a department with no consumable items', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), dynamoClient: client });

    const result = await handler(buildEvent(MEMBER));

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({ items: [] });
  });

  it('returns a 500 problem response when the verified principal carries an invalid deptId', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), dynamoClient: client });

    const result = await handler(buildEvent({ ...MEMBER, deptId: 'DEPT#1' }));

    expect(result).toMatchObject({ statusCode: 500 });
    expect((result as { headers?: Record<string, string> }).headers?.['content-type']).toBe(
      'application/problem+json',
    );
  });

  it('returns a 500 problem response when the DynamoDB query fails (fail-closed)', async () => {
    const client = fakeDocClient(() => {
      throw new Error('DynamoDB unavailable');
    });
    const { createHandler } = await import('./handler.js');
    const handler = createHandler({ authzClient: fakeAuthzClient('ALLOW'), dynamoClient: client });

    const result = await handler(buildEvent(MEMBER));

    expect(result).toMatchObject({ statusCode: 500 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({
      title: 'Internal Server Error',
    });
  });
});
