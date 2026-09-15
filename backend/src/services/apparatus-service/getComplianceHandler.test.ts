import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const ADMIN: CedarPrincipalContext = {
  sub: 'chief-1',
  deptId: 'dept-001',
  'cognito:groups': 'admin',
};

function buildEvent(
  queryStringParameters: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = ADMIN,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/compliance',
    rawPath: '/api/v1/apparatus/compliance',
    rawQueryString: '',
    headers,
    queryStringParameters,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' | Error = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send:
      decision instanceof Error
        ? vi.fn().mockRejectedValue(decision)
        : vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function fakeDynamoClient(
  handler: (command: QueryCommand) => Promise<unknown>,
): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => {
      if (command instanceof QueryCommand) {
        return handler(command);
      }
      return Promise.reject(new Error('unexpected command'));
    }),
  } as unknown as DynamoDBDocumentClient;
}

async function importHandler() {
  const { createGetComplianceHandler } = await import('./getComplianceHandler.js');
  return createGetComplianceHandler;
}

describe('getComplianceHandler (entrypoint)', () => {
  it('returns 403 on a Cedar deny, before any DynamoDB call (AC3)', async () => {
    const createGetComplianceHandler = await importHandler();
    const send = vi.fn();
    const handler = createGetComplianceHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient('DENY'),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798100000' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 403 when the bearer token is missing (AC3)', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798100000' }, ADMIN, {}));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable (AC3)', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient(new Error('VP outage')),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798100000' }));

    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when from/to are missing', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when from/to are non-numeric', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: 'abc', to: '1798100000' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when to is before from', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: '1798100000', to: '1798000000' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with every roster apparatus and flags zero-check apparatus non-compliant rather than omitting it (AC1/AC2)', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient((command) =>
        Promise.resolve(
          command.input.KeyConditionExpression?.includes('BETWEEN')
            ? {
                Items: [
                  {
                    pk: 'DEPT#dept-001#APPARATUS#APP-ENGINE-1',
                    completedAt: 1798000000,
                  },
                ],
              }
            : {
                Items: [
                  {
                    pk: 'DEPT#dept-001#APPARATUS#APP-ENGINE-1',
                    unitId: 'ENGINE-1',
                    type: 'ENGINE',
                    status: 'IN_SERVICE',
                  },
                  {
                    pk: 'DEPT#dept-001#APPARATUS#APP-LADDER-1',
                    unitId: 'LADDER-1',
                    type: 'LADDER',
                    status: 'IN_SERVICE',
                  },
                ],
              },
        ),
      ),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798000000' }));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      report: { unitId: string; compliant: boolean; actualChecks: number }[];
    };
    expect(body.report).toHaveLength(2);
    expect(body.report).toContainEqual(
      expect.objectContaining({ unitId: 'LADDER-1', actualChecks: 0, compliant: false }),
    );
    expect(body.report).toContainEqual(
      expect.objectContaining({ unitId: 'ENGINE-1', actualChecks: 1, compliant: true }),
    );
  });

  it('returns 400 when the requested range exceeds the maximum window', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(
      buildEvent({ from: '1798000000', to: String(1798000000 + 401 * 86400) }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with an empty report when the department has no apparatus', async () => {
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.resolve({ Items: [] })),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798000000' }));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { report: unknown[] };
    expect(body.report).toEqual([]);
  });

  it('returns 503 and logs the original error when the roster query fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createGetComplianceHandler = await importHandler();
    const handler = createGetComplianceHandler({
      client: fakeDynamoClient(() => Promise.reject(new Error('table throttled'))),
      authzClient: fakeAuthzClient('ALLOW'),
    });

    const result = await handler(buildEvent({ from: '1798000000', to: '1798000000' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('apparatus.compliance.error'));
    errorSpy.mockRestore();
  });

  it('engages the default (production) dependency wiring when no overrides are supplied', async () => {
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () =>
          fakeDynamoClient((command) =>
            Promise.resolve(
              command.input.KeyConditionExpression?.includes('BETWEEN')
                ? { Items: [] }
                : { Items: [] },
            ),
          ),
      };
    });
    vi.doMock('@boxalarm/authz', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@boxalarm/authz')>();
      return {
        ...actual,
        withAuthorization: (
          inner: (event: GuardEvent, principal: CedarPrincipalContext) => unknown,
          options: unknown,
        ) =>
          actual.withAuthorization(
            inner as never,
            { ...(options as object), client: fakeAuthzClient('ALLOW') } as never,
          ),
      };
    });

    const { handler } = await import('./getComplianceHandler.js');
    const result = await handler(buildEvent({ from: '1798000000', to: '1798000000' }));

    expect(result).toMatchObject({ statusCode: 200 });
    vi.doUnmock('./dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
  });
});
