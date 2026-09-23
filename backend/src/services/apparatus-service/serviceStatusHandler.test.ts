import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const OFFICER: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'dept-001',
  'cognito:groups': 'officer',
};
const NON_PRIVILEGED: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'member',
};

function buildEvent(
  principal: CedarPrincipalContext | undefined,
  overrides: { pathParameters?: Record<string, string> | undefined; body?: string } = {},
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'PUT /api/v1/apparatus/{unitId}/service-status',
    rawPath: '/api/v1/apparatus/E1/service-status',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: 'pathParameters' in overrides ? overrides.pathParameters : { unitId: 'E1' },
    body: overrides.body,
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

async function mockRepository(overrides: Record<string, unknown>): Promise<void> {
  const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
  vi.doMock('./repository.js', () => ({ ...actual, ...overrides }));
}

function mockDynamoClient(): void {
  vi.doMock('./client.js', () => ({
    createDynamoClient: vi.fn(() => ({})),
    readApparatusConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  }));
}

describe('serviceStatusHandler', () => {
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

  it('rejects a non-privileged member before touching the repository (AC4)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    const setServiceStatus = vi.fn();
    await mockRepository({ setServiceStatus });

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(NON_PRIVILEGED, {
        body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(setServiceStatus).not.toHaveBeenCalled();
  });

  it('returns 503 and never touches the repository when Verified Permissions is unavailable (core-harm)', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    const setServiceStatus = vi.fn();
    await mockRepository({ setServiceStatus });

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }) }),
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(setServiceStatus).not.toHaveBeenCalled();
  });

  it('returns 400 when status=OUT_OF_SERVICE and reason is empty', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const setServiceStatus = vi.fn();
    await mockRepository({ setServiceStatus });

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: '' }) }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(setServiceStatus).not.toHaveBeenCalled();
  });

  it('logs the JSON.parse failure before returning 400 for a malformed body (error-context)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockRepository({ setServiceStatus: vi.fn() });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(buildEvent(OFFICER, { body: '{not-json' }));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('apparatus.serviceStatus.parseBody.failed'),
    );
    errorSpy.mockRestore();
  });

  it('returns 400 for an unknown/malformed status value', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockRepository({ setServiceStatus: vi.fn() });

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'BROKEN' }) }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when the unitId path parameter is empty', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockRepository({ setServiceStatus: vi.fn() });

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, {
        pathParameters: {},
        body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('flips the apparatus to OUT_OF_SERVICE and returns 204 on success (AC1, entrypoint)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const setServiceStatus = vi.fn().mockResolvedValue(undefined);
    await mockRepository({ setServiceStatus });
    mockDynamoClient();

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, {
        body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'Pump failure' }),
      }),
    );

    expect(result).toEqual({ statusCode: 204 });
    expect(setServiceStatus).toHaveBeenCalledWith({}, 'platform-table', {
      deptId: 'dept-001',
      unitId: 'E1',
      status: 'OUT_OF_SERVICE',
      reason: 'Pump failure',
    });
  });

  it('returns the apparatus to IN_SERVICE and returns 204 on success (AC2, entrypoint)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const setServiceStatus = vi.fn().mockResolvedValue(undefined);
    await mockRepository({ setServiceStatus });
    mockDynamoClient();

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'IN_SERVICE' }) }),
    );

    expect(result).toEqual({ statusCode: 204 });
    expect(setServiceStatus).toHaveBeenCalledWith({}, 'platform-table', {
      deptId: 'dept-001',
      unitId: 'E1',
      status: 'IN_SERVICE',
    });
  });

  it('maps ApparatusNotFoundError to 404', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
    await mockRepository({
      setServiceStatus: vi.fn().mockRejectedValue(new actual.ApparatusNotFoundError('E1')),
    });
    mockDynamoClient();

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }) }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('maps ServiceStatusConflictError to 409 (already-in-that-state and no-open-record rows)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
    await mockRepository({
      setServiceStatus: vi
        .fn()
        .mockRejectedValue(new actual.ServiceStatusConflictError('already out of service')),
    });
    mockDynamoClient();

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }) }),
    );

    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('maps ApparatusRepositoryUnavailableError to 503 (DynamoDB TransactWriteItems dependency down)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
    await mockRepository({
      setServiceStatus: vi
        .fn()
        .mockRejectedValue(new actual.ApparatusRepositoryUnavailableError(new Error('down'))),
    });
    mockDynamoClient();

    const { handler } = await import('./serviceStatusHandler.js');
    const result = await handler(
      buildEvent(OFFICER, { body: JSON.stringify({ status: 'OUT_OF_SERVICE', reason: 'x' }) }),
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
