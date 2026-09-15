import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const CHIEF: CedarPrincipalContext = {
  sub: 'chief-1',
  deptId: 'dept-001',
  'cognito:groups': 'chief',
};

function buildEvent(
  principal: CedarPrincipalContext | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  queryStringParameters?: Record<string, string>,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus',
    rawPath: '/api/v1/apparatus',
    rawQueryString: '',
    headers,
    queryStringParameters,
    requestContext: { authorizer: { lambda: principal } },
  } as unknown as GuardEvent;
}

function mockVerifiedPermissions(sendImpl: () => Promise<{ decision: string }>): void {
  vi.doMock('@aws-sdk/client-verifiedpermissions', () => ({
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vi.fn(sendImpl) })),
    IsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    BatchIsAuthorizedWithTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    Decision: { ALLOW: 'ALLOW', DENY: 'DENY' },
  }));
}

function mockDynamoClient(): void {
  vi.doMock('./client.js', () => ({
    createDynamoClient: vi.fn(() => ({})),
    readApparatusConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  }));
}

async function mockRepository(overrides: Record<string, unknown>): Promise<void> {
  const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
  vi.doMock('./repository.js', () => ({ ...actual, ...overrides }));
}

describe('listHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('./client.js');
    vi.doUnmock('./repository.js');
  });

  it('returns 403 on a missing/malformed bearer token', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockRepository({ listApparatus: vi.fn() });

    const { handler } = await import('./listHandler.js');
    const result = await handler(buildEvent(CHIEF, {}));

    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 when Verified Permissions is unavailable', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    const listApparatus = vi.fn();
    await mockRepository({ listApparatus });

    const { handler } = await import('./listHandler.js');
    const result = await handler(buildEvent(CHIEF));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(listApparatus).not.toHaveBeenCalled();
  });

  it('lists currently out-of-service apparatus with reason and elapsed duration (AC3, entrypoint)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const listApparatus = vi.fn().mockResolvedValue([
      { unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' },
      {
        unitId: 'L1',
        type: 'LADDER',
        status: 'OUT_OF_SERVICE',
        outOfService: { reason: 'Pump failure', startAt: 1700000000000, elapsedSeconds: 120 },
      },
    ]);
    await mockRepository({ listApparatus });
    mockDynamoClient();

    const { handler } = await import('./listHandler.js');
    const result = await handler(buildEvent(CHIEF));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      apparatus: readonly unknown[];
    };
    expect(body.apparatus).toHaveLength(2);
    expect(body.apparatus).toContainEqual(
      expect.objectContaining({
        unitId: 'L1',
        outOfService: { reason: 'Pump failure', startAt: 1700000000000, elapsedSeconds: 120 },
      }),
    );
    expect(listApparatus).toHaveBeenCalledWith({}, 'platform-table', 'dept-001', undefined);
  });

  it('passes a recognized status query filter through to the repository and ignores an unknown one', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const listApparatus = vi.fn().mockResolvedValue([]);
    await mockRepository({ listApparatus });
    mockDynamoClient();

    const { handler } = await import('./listHandler.js');
    await handler(
      buildEvent(CHIEF, { authorization: 'Bearer token' }, { status: 'OUT_OF_SERVICE' }),
    );
    await handler(buildEvent(CHIEF, { authorization: 'Bearer token' }, { status: 'bogus' }));

    expect(listApparatus).toHaveBeenNthCalledWith(
      1,
      {},
      'platform-table',
      'dept-001',
      'OUT_OF_SERVICE',
    );
    expect(listApparatus).toHaveBeenNthCalledWith(2, {}, 'platform-table', 'dept-001', undefined);
  });

  it('does not leak the internal apparatusId field on the registry response body', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const listApparatus = vi.fn().mockResolvedValue([
      { apparatusId: 'APP-ENGINE-2', unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' },
    ]);
    await mockRepository({ listApparatus });
    mockDynamoClient();

    const { handler } = await import('./listHandler.js');
    const result = await handler(buildEvent(CHIEF));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      apparatus: readonly unknown[];
    };
    expect(body.apparatus).toEqual([{ unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' }]);
    expect(body.apparatus[0]).not.toHaveProperty('apparatusId');
  });

  it('maps a DynamoDB registry-query failure to 503 rather than an unhandled throw', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
    await mockRepository({
      listApparatus: vi
        .fn()
        .mockRejectedValue(new actual.ApparatusRepositoryUnavailableError(new Error('down'))),
    });
    mockDynamoClient();

    const { handler } = await import('./listHandler.js');
    const result = await handler(buildEvent(CHIEF));

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
