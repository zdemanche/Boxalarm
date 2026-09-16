import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import type { ApparatusEvent } from '../authContext.js';

const OFFICER: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'NICHOLS',
  'cognito:groups': 'officer',
};

function buildGetEvent(
  lambdaContext: Record<string, unknown> | undefined,
  dispatchId: string | undefined,
): ApparatusEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/riding-board/{dispatchId}',
    rawPath: `/api/v1/apparatus/riding-board/${dispatchId ?? ''}`,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    pathParameters: dispatchId !== undefined ? { dispatchId } : undefined,
    requestContext: {
      requestId: 'req-1',
      http: { method: 'GET' },
      authorizer: lambdaContext !== undefined ? { lambda: lambdaContext } : undefined,
    },
  } as unknown as ApparatusEvent;
}

function buildPostEvent(
  principal: CedarPrincipalContext | undefined,
  overrides: { pathParameters?: Record<string, string> | undefined; body?: string } = {},
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/riding-board/{dispatchId}/assignments',
    rawPath: '/api/v1/apparatus/riding-board/DISPATCH-1/assignments',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters:
      'pathParameters' in overrides ? overrides.pathParameters : { dispatchId: 'DISPATCH-1' },
    body: overrides.body,
    requestContext: { requestId: 'req-1', authorizer: { lambda: principal } },
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
  vi.doMock('../client.js', () => ({
    createDynamoClient: vi.fn(() => ({})),
    readApparatusConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  }));
}

async function mockApparatusRepository(overrides: Record<string, unknown>): Promise<void> {
  const actual = await vi.importActual<typeof import('../repository.js')>('../repository.js');
  vi.doMock('../repository.js', () => ({ ...actual, ...overrides }));
}

async function mockRidingBoardRepository(overrides: Record<string, unknown>): Promise<void> {
  const actual = await vi.importActual<typeof import('./repository.js')>('./repository.js');
  vi.doMock('./repository.js', () => ({ ...actual, ...overrides }));
}

describe('getRidingBoardHandler (entrypoint)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./repository.js');
    vi.doUnmock('../client.js');
    vi.restoreAllMocks();
  });

  it('AC1: returns 200 with the riding board', async () => {
    await mockRidingBoardRepository({
      getRidingBoard: vi.fn().mockResolvedValue({ dispatchId: 'DISPATCH-1', apparatus: [] }),
    });
    mockDynamoClient();
    const { getRidingBoardHandler: handler } = await import('./handler.js');

    const result = await handler(
      buildGetEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }, 'DISPATCH-1'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const { getRidingBoardHandler: handler } = await import('./handler.js');

    const result = await handler(
      buildGetEvent(undefined, 'DISPATCH-1'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 400 when dispatchId is missing', async () => {
    const { getRidingBoardHandler: handler } = await import('./handler.js');

    const result = await handler(
      buildGetEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }, undefined),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 when the board read fails (DynamoDB unavailable)', async () => {
    await mockRidingBoardRepository({
      getRidingBoard: vi.fn().mockRejectedValue(new Error('table not found')),
    });
    mockDynamoClient();
    const { getRidingBoardHandler: handler } = await import('./handler.js');

    const result = await handler(
      buildGetEvent({ sub: 'member-1', deptId: 'NICHOLS', 'cognito:groups': '' }, 'DISPATCH-1'),
      {} as never,
      () => undefined,
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });
});

describe('assignRidingPositionHandler (entrypoint)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('@aws-sdk/client-verifiedpermissions');
    vi.doUnmock('../client.js');
    vi.doUnmock('../repository.js');
    vi.doUnmock('./repository.js');
  });

  it('rejects a non-officer principal before touching the repository (fail-secure)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'DENY' }));
    const assignSeat = vi.fn();
    await mockRidingBoardRepository({ assignSeat });

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-1',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 403 });
    expect(assignSeat).not.toHaveBeenCalled();
  });

  it('returns 503 and never touches the repository when Verified Permissions is unavailable (core-harm)', async () => {
    mockVerifiedPermissions(() => Promise.reject(new Error('VP outage')));
    const assignSeat = vi.fn();
    await mockRidingBoardRepository({ assignSeat });

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-1',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 503 });
    expect(assignSeat).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty request body', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(buildPostEvent(OFFICER, {}));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when dispatchId is missing from the path', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, { pathParameters: {}, body: JSON.stringify({}) }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when expectedVersion is wrong-typed (string)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-1',
          expectedVersion: '0',
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 when the apparatus unitId is unknown', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({ findApparatusItem: vi.fn().mockResolvedValue(undefined) });
    await mockRidingBoardRepository({ getRidingPositionsConfig: vi.fn().mockResolvedValue({}) });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'NO-SUCH-UNIT',
          positionCode: 'DRIVER',
          memberId: 'MBR-1',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 for a positionCode not configured for the apparatus type', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({
      findApparatusItem: vi.fn().mockResolvedValue({
        apparatusId: 'APP-ENGINE-2',
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    });
    await mockRidingBoardRepository({
      getRidingPositionsConfig: vi
        .fn()
        .mockResolvedValue({ ENGINE: [{ code: 'DRIVER', label: 'Driver' }] }),
    });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'NOT-A-SEAT',
          memberId: 'MBR-1',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('AC8: maps a CONFLICT outcome to 409 with the winning assignment in the body', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({
      findApparatusItem: vi.fn().mockResolvedValue({
        apparatusId: 'APP-ENGINE-2',
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    });
    await mockRidingBoardRepository({
      getRidingPositionsConfig: vi
        .fn()
        .mockResolvedValue({ ENGINE: [{ code: 'DRIVER', label: 'Driver' }] }),
      assignSeat: vi.fn().mockResolvedValue({
        kind: 'CONFLICT',
        current: {
          apparatusId: 'APP-ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-0034',
          version: 2,
          assignedAt: 1_700_000_000,
          assignedBy: 'officer-2',
        },
      }),
    });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-0012',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 409 });
    const body = JSON.parse((result as { body: string }).body) as {
      currentAssignment: { memberId: string };
    };
    expect(body.currentAssignment.memberId).toBe('MBR-0034');
  });

  it('AC4: maps an OUT_OF_SERVICE outcome to 409 with the reason visible', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({
      findApparatusItem: vi.fn().mockResolvedValue({
        apparatusId: 'APP-ENGINE-2',
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    });
    await mockRidingBoardRepository({
      getRidingPositionsConfig: vi
        .fn()
        .mockResolvedValue({ ENGINE: [{ code: 'DRIVER', label: 'Driver' }] }),
      assignSeat: vi.fn().mockResolvedValue({ kind: 'OUT_OF_SERVICE', reason: 'Pump failure' }),
    });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-0012',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 409 });
    const body = JSON.parse((result as { body: string }).body) as { reason: string };
    expect(body.reason).toBe('Pump failure');
  });

  it('returns 200 on a successful assignment (entrypoint, AC1)', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({
      findApparatusItem: vi.fn().mockResolvedValue({
        apparatusId: 'APP-ENGINE-2',
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    });
    await mockRidingBoardRepository({
      getRidingPositionsConfig: vi
        .fn()
        .mockResolvedValue({ ENGINE: [{ code: 'DRIVER', label: 'Driver' }] }),
      assignSeat: vi.fn().mockResolvedValue({
        kind: 'ASSIGNED',
        apparatusId: 'APP-ENGINE-2',
        positionCode: 'DRIVER',
        memberId: 'MBR-0012',
        previousMemberId: null,
        version: 1,
      }),
    });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-0012',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('returns 503 when the write fails unexpectedly', async () => {
    mockVerifiedPermissions(() => Promise.resolve({ decision: 'ALLOW' }));
    await mockApparatusRepository({
      findApparatusItem: vi.fn().mockResolvedValue({
        apparatusId: 'APP-ENGINE-2',
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    });
    await mockRidingBoardRepository({
      getRidingPositionsConfig: vi
        .fn()
        .mockResolvedValue({ ENGINE: [{ code: 'DRIVER', label: 'Driver' }] }),
      assignSeat: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
    });
    mockDynamoClient();

    const { assignRidingPositionHandler } = await import('./handler.js');
    const result = await assignRidingPositionHandler(
      buildPostEvent(OFFICER, {
        body: JSON.stringify({
          unitId: 'ENGINE-2',
          positionCode: 'DRIVER',
          memberId: 'MBR-0012',
          expectedVersion: 0,
          clientAssignmentId: 'CLIENT-1',
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 503 });
  });
});
