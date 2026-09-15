import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { GuardEvent, WithAuthorizationOptions } from '@boxalarm/authz';
import type { CedarPrincipalContext } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'member',
};

function buildEvent(
  unitId: string | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/{unitId}/checklist',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/checklist`,
    rawQueryString: '',
    headers,
    pathParameters: unitId === undefined ? undefined : { unitId },
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

function authzClient(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function dynamoClient(
  behavior: (command: { input: { IndexName?: string } }) => Promise<unknown>,
): DynamoDBDocumentClient {
  return { send: vi.fn(behavior) } as unknown as DynamoDBDocumentClient;
}

const APPARATUS_ITEM = { pk: 'DEPT#NICHOLS#APPARATUS#APP-ENGINE-2', sk: 'METADATA' };
const TEMPLATE_ITEM = {
  pk: 'DEPT#NICHOLS#CHECKLIST_TEMPLATE#CT-01',
  sk: 'METADATA',
  name: 'Engine daily check',
  applicableApparatusIds: ['APP-ENGINE-2'],
  items: [{ code: 'TIRES', label: 'Tire pressure', requiresPhoto: true }],
};

describe('getChecklistHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./dynamoClient.js');
    vi.unmock('@boxalarm/authz');
    vi.resetModules();
  });

  it('returns 400 when unitId is missing from the path', async () => {
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => dynamoClient(() => Promise.resolve({})) };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 403 for an unauthorized principal before any DynamoDB call (AC-adjacent auth gate)', async () => {
    const send = vi.fn();
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('DENY') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 503 when Verified Permissions is unavailable (fail-closed, never a defaulted allow)', async () => {
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      const unavailableClient = {
        send: vi.fn().mockRejectedValue(new Error('VP outage')),
      } as unknown as VerifiedPermissionsClient;
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: unavailableClient }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 200 with the resolved template, requiresPhoto round-tripped (AC1/AC3 contract)', async () => {
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () =>
          dynamoClient((command) =>
            Promise.resolve(
              command.input.IndexName ? { Items: [APPARATUS_ITEM] } : { Items: [TEMPLATE_ITEM] },
            ),
          ),
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = (await handler(buildEvent('ENGINE-2'))) as {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('application/json');
    const body = JSON.parse(result.body) as {
      templateId: string;
      items: { requiresPhoto: boolean }[];
    };
    expect(body.templateId).toBe('CT-01');
    expect(body.items[0]?.requiresPhoto).toBe(true);
  });

  it('returns 404 when the unitId does not resolve to a known apparatus', async () => {
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => dynamoClient(() => Promise.resolve({ Items: [] })),
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('UNKNOWN-UNIT'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 404 when the apparatus resolves but no template applies to it', async () => {
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () =>
          dynamoClient((command) =>
            Promise.resolve(command.input.IndexName ? { Items: [APPARATUS_ITEM] } : { Items: [] }),
          ),
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 503 (not an unhandled crash) when PLATFORM_TABLE_NAME is unset', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('apparatus.checklist.error'));
    errorSpy.mockRestore();
  });

  it('returns 503 (not an unhandled crash) when DynamoDB throws, logging the original error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () =>
          dynamoClient(() => Promise.reject(new Error('DynamoDB throttled'))),
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (inner: never, options: WithAuthorizationOptions) =>
          actual.withAuthorization(inner, { ...options, client: authzClient('ALLOW') }),
      };
    });
    const { handler } = await import('./getChecklistHandler.js');

    const result = await handler(buildEvent('ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('apparatus.checklist.error'));
    errorSpy.mockRestore();
  });
});
