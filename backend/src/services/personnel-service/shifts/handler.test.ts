import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildMember, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = 'dept-001';
const VERIFIED_DEPT_ID = toVerifiedDeptId({ deptId: DEPT_ID });
const authzSend = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-verifiedpermissions')>(
    '@aws-sdk/client-verifiedpermissions',
  );
  // A plain constructor function (not vi.fn()) so `vi.restoreAllMocks()` elsewhere in this
  // file — used to reset DynamoDB/console spies — cannot wipe this mock's implementation.
  function FakeVerifiedPermissionsClient(): { send: typeof authzSend } {
    return { send: authzSend };
  }
  return {
    ...actual,
    VerifiedPermissionsClient: FakeVerifiedPermissionsClient,
  };
});

function buildEvent(
  overrides: Partial<{
    method: string;
    path: string;
    body: string | undefined;
    groups: string;
    requestId: string;
    deptId: string;
    rawPath: string;
    sub: string;
    authorization: string;
  }> = {},
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  const method = overrides.method ?? 'POST';
  const path = overrides.rawPath ?? overrides.path ?? '/api/v1/personnel/shifts';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers:
      overrides.authorization !== undefined ? { authorization: overrides.authorization } : {},
    body: overrides.body,
    isBase64Encoded: false,
    requestContext: {
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: '',
      },
      requestId: overrides.requestId ?? 'req-1',
      authorizer: {
        lambda: {
          sub: overrides.sub ?? 'member-1',
          deptId: overrides.deptId ?? DEPT_ID,
          'cognito:groups': overrides.groups ?? 'OFFICER',
        },
      },
    } as unknown as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>['requestContext'],
  } as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
}

const validCreateBody = JSON.stringify({
  startAt: 1_000,
  endAt: 2_000,
  stationId: 'station-1',
  positions: [{ positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' }],
});

describe('shifts handler', () => {
  const originalEnv = { ...process.env };
  const mockSend = vi.fn();
  const mockListMembers = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockListMembers.mockReset();
    mockListMembers.mockResolvedValue([]);
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    vi.doMock('./dynamoClient.js', async () => {
      const actual = await vi.importActual<typeof import('./dynamoClient.js')>('./dynamoClient.js');
      return {
        ...actual,
        getDocClient: () => ({ send: mockSend }),
        readPersonnelTableConfig: () => ({ tableName: 'platform-service' }),
      };
    });
    vi.doMock('../lib/memberRepository.js', () => ({
      listMembers: mockListMembers,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./dynamoClient.js');
    vi.unmock('../lib/memberRepository.js');
    vi.restoreAllMocks();
  });

  it('creates a DUTY_SHIFT with OPEN status and one unclaimed SHIFT_POSITION per position (AC1)', async () => {
    mockSend.mockResolvedValueOnce({});
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: string;
      positions: unknown[];
    };
    expect(body.status).toBe('OPEN');
    expect(body.positions).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-officer member with 403 (AC3)', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody, groups: 'MEMBER' }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an empty cognito:groups claim with 403 rather than crashing', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody, groups: '' }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('accepts a lower-cased officer group name', async () => {
    mockSend.mockResolvedValueOnce({});
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody, groups: 'officer' }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 201 });
  });

  it('rejects an absent body with 400', async () => {
    const { handler } = await import('./handler.js');
    const result = await handler(buildEvent({ body: undefined }), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects an empty positions array with 400', async () => {
    const { handler } = await import('./handler.js');
    const body = JSON.stringify({
      startAt: 1_000,
      endAt: 2_000,
      stationId: 'station-1',
      positions: [],
    });
    const result = await handler(buildEvent({ body }), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a wrong-typed startAt with 400', async () => {
    const { handler } = await import('./handler.js');
    const body = JSON.stringify({
      startAt: 'not-a-number',
      endAt: 2_000,
      stationId: 'station-1',
      positions: [{ positionCode: 'DRIVER' }],
    });
    const result = await handler(buildEvent({ body }), {} as never, () => undefined);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 (fail-closed) and logs the original error when TransactWriteItems throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockRejectedValueOnce(new Error('transact write failed'));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('transact write failed'));
  });

  it('returns 503 (fail-closed) and logs the original error when Query throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockRejectedValueOnce(new Error('query failed'));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ method: 'GET', body: undefined }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('query failed'));
  });

  it('returns 500 and logs when the authorizer deptId claim is malformed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ body: validCreateBody, deptId: 'dept#001' }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 500 });
    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('shifts.create.invalid_dept'));
  });

  it('lists shifts with status OPEN when none are filled (AC2), empty result set', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ method: 'GET', body: undefined }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { shifts: unknown[] };
    expect(body.shifts).toEqual([]);
  });

  it('follows LastEvaluatedKey to collect every page of a shift list', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          {
            shiftId: 'shift-1',
            startAt: 1_000,
            endAt: 2_000,
            stationId: 'station-1',
            status: 'OPEN',
          },
        ],
        LastEvaluatedKey: { pk: 'DEPT#dept-001#SHIFT#shift-1', sk: 'METADATA' },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            shiftId: 'shift-2',
            startAt: 3_000,
            endAt: 4_000,
            stationId: 'station-2',
            status: 'OPEN',
          },
        ],
      });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ method: 'GET', body: undefined }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { shifts: { shiftId: string }[] };
    expect(body.shifts.map((shift) => shift.shiftId)).toEqual(['shift-1', 'shift-2']);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('lists a populated shift with status OPEN', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          shiftId: 'shift-1',
          startAt: 1_000,
          endAt: 2_000,
          stationId: 'station-1',
          status: 'OPEN',
        },
      ],
    });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({ method: 'GET', body: undefined }),
      {} as never,
      () => undefined,
    );
    const body = JSON.parse((result as { body: string }).body) as { shifts: { status: string }[] };
    expect(body.shifts[0]?.status).toBe('OPEN');
  });

  describe('GET .../shifts/coverage', () => {
    function buildCoverageEvent(
      overrides: Parameters<typeof buildEvent>[0] = {},
    ): ReturnType<typeof buildEvent> {
      return buildEvent({
        method: 'GET',
        path: '/api/v1/personnel/shifts/coverage',
        body: undefined,
        ...overrides,
      });
    }

    it('rejects a non-officer member with 403', async () => {
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildCoverageEvent({ groups: 'MEMBER' }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 403 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 500 when the authorizer deptId claim is malformed', async () => {
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildCoverageEvent({ deptId: 'dept#001' }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 500 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 503 (fail-closed) and logs the original error when the shift query throws', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockSend.mockRejectedValueOnce(new Error('coverage query failed'));
      const { handler } = await import('./handler.js');
      const result = await handler(buildCoverageEvent(), {} as never, () => undefined);
      expect(result).toMatchObject({ statusCode: 503 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('coverage query failed'));
    });

    it('returns 200 with an empty shifts array when the department has no shifts', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      const { handler } = await import('./handler.js');
      const result = await handler(buildCoverageEvent(), {} as never, () => undefined);
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as { shifts: unknown[] };
      expect(body.shifts).toEqual([]);
    });

    it('classifies covered, short, and qual-gapped positions on one shift (AC1, AC2)', async () => {
      const futureEndAt = Date.now() + 3_600_000;
      mockSend
        .mockResolvedValueOnce({
          Items: [
            {
              shiftId: 'shift-1',
              startAt: futureEndAt - 1_000,
              endAt: futureEndAt,
              stationId: 'station-1',
              status: 'OPEN',
            },
          ],
        })
        .mockResolvedValueOnce({
          Items: [
            { pk: 'DEPT#dept-001#SHIFT#shift-1', sk: 'METADATA' },
            {
              pk: 'DEPT#dept-001#SHIFT#shift-1',
              sk: 'POSITION#DRIVER',
              positionCode: 'DRIVER',
              requiredQual: 'DRIVER_OPERATOR',
              claimedByMemberId: 'member-1',
            },
            {
              pk: 'DEPT#dept-001#SHIFT#shift-1',
              sk: 'POSITION#FF1',
              positionCode: 'FF1',
            },
            {
              pk: 'DEPT#dept-001#SHIFT#shift-1',
              sk: 'POSITION#OFFICER',
              positionCode: 'OFFICER',
              requiredQual: 'OFFICER_CERT',
            },
          ],
        });
      const { handler } = await import('./handler.js');
      const result = await handler(buildCoverageEvent(), {} as never, () => undefined);
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        shifts: { positions: { positionCode: string; status: string }[] }[];
      };
      expect(
        body.shifts[0]?.positions.map((position) => [position.positionCode, position.status]),
      ).toEqual([
        ['DRIVER', 'covered'],
        ['FF1', 'short'],
        ['OFFICER', 'qual-gapped'],
      ]);
    });

    it('never issues a TransactWriteCommand or UpdateCommand while computing coverage on a gap (AC3)', async () => {
      const futureEndAt = Date.now() + 3_600_000;
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            shiftId: 'shift-1',
            startAt: futureEndAt - 1_000,
            endAt: futureEndAt,
            stationId: 'station-1',
            status: 'OPEN',
          },
        ],
      });
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#dept-001#SHIFT#shift-1',
            sk: 'POSITION#OFFICER',
            positionCode: 'OFFICER',
            requiredQual: 'OFFICER_CERT',
          },
        ],
      });
      const { handler } = await import('./handler.js');
      const result = await handler(buildCoverageEvent(), {} as never, () => undefined);
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        shifts: { positions: { status: string }[] }[];
      };
      expect(body.shifts[0]?.positions[0]?.status).toBe('qual-gapped');
      for (const call of mockSend.mock.calls) {
        const commandName = (call[0] as { constructor: { name: string } }).constructor.name;
        expect(commandName).not.toBe('TransactWriteCommand');
        expect(commandName).not.toBe('UpdateCommand');
      }
    });
  });
});

describe('shifts handler — release/swap/approve routes', () => {
  const originalEnv = { ...process.env };

  function mockFakeDoc(seed: readonly Record<string, unknown>[]): void {
    const fakeDoc = createFakeDocumentClient(seed);
    vi.doMock('./dynamoClient.js', () => ({
      getDocClient: () => fakeDoc,
      readPersonnelTableConfig: () => ({ tableName: 'platform-service' }),
      GSI3_INDEX_NAME: 'GSI3',
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    authzSend.mockReset();
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unmock('./dynamoClient.js');
    vi.restoreAllMocks();
  });

  it('AC1: POST /shifts/{id}/release clears the claim and re-triggers status recalculation', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { released: boolean };
    expect(body.released).toBe(true);
  });

  it('AC1: POST /shifts/{id}/release with a missing positionCode returns 400', async () => {
    mockFakeDoc([]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({}),
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('AC1: POST /shifts/{id}/release returns 409 when not claimed by the caller', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-2' }),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('POST /shifts/{id}/release returns 503 (fail-closed) and logs the original error when DynamoDB is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('./dynamoClient.js', () => ({
      getDocClient: () => ({ send: () => Promise.reject(new Error('DynamoDB unavailable')) }),
      readPersonnelTableConfig: () => ({ tableName: 'platform-service' }),
    }));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('shifts.release.write_failed'));
  });

  it('AC1: release succeeds with 200 even when the post-commit status recalculation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realDoc = createFakeDocumentClient([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
    ]);
    const wrappedDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'QueryCommand') {
          return Promise.reject(new Error('recalculate query failed'));
        }
        return (realDoc as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      },
    };
    vi.doMock('./dynamoClient.js', () => ({
      getDocClient: () => wrappedDoc,
      readPersonnelTableConfig: () => ({ tableName: 'platform-service' }),
    }));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { released: boolean };
    expect(body.released).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('shifts.release.recalculate_failed'),
    );
  });

  it('AC2: POST /shifts/{id}/swap creates a PENDING request when requiresOfficerApproval is true', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      buildMember(VERIFIED_DEPT_ID, 'member-2'),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap',
        body: JSON.stringify({ positionCode: 'DRIVER', toMemberId: 'member-2' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: string;
      requiresOfficerApproval: boolean;
    };
    expect(body.status).toBe('PENDING');
    expect(body.requiresOfficerApproval).toBe(true);
  });

  it('POST /shifts/{id}/swap with a missing toMemberId returns 400', async () => {
    mockFakeDoc([]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('POST /shifts/{id}/swap returns 409 when the caller does not currently hold the position', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-9' }),
      buildMember(VERIFIED_DEPT_ID, 'member-2'),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap',
        body: JSON.stringify({ positionCode: 'DRIVER', toMemberId: 'member-2' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('POST /shifts/{id}/swap returns 404 when toMemberId does not resolve to a real department member', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap',
        body: JSON.stringify({ positionCode: 'DRIVER', toMemberId: 'member-unknown' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('POST /shifts/{id}/swap returns 400 when toMemberId equals the caller', async () => {
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap',
        body: JSON.stringify({ positionCode: 'DRIVER', toMemberId: 'member-1' }),
        sub: 'member-1',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('AC4: POST /shifts/{id}/swap/{swapId}/approve by a non-officer returns 403 when requiresOfficerApproval is true', async () => {
    const requestedAt = 1_800_000_500;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'MEMBER',
        sub: 'member-3',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('AC4: POST /shifts/{id}/swap/{swapId}/approve by an officer approves and transfers the claim', async () => {
    const requestedAt = 1_800_000_600;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);
    authzSend.mockResolvedValue({ decision: Decision.ALLOW });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'OFFICER',
        sub: 'chief-1',
        authorization: 'Bearer token',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      status: string;
      claimedByMemberId: string;
    };
    expect(body.status).toBe('APPROVED');
    expect(body.claimedByMemberId).toBe('member-2');
    expect(authzSend).toHaveBeenCalledTimes(1);
    const vpCall = authzSend.mock.calls[0]?.[0] as {
      input: {
        action: { actionType: string; actionId: string };
        resource: { entityType: string; entityId: string };
      };
    };
    expect(vpCall.input.action).toEqual({
      actionType: 'Boxalarm::Action',
      actionId: 'ApproveShiftSwap',
    });
    expect(vpCall.input.resource).toEqual({
      entityType: 'Boxalarm::ShiftSwapRequest',
      entityId: String(requestedAt),
    });
  });

  it('POST /shifts/{id}/swap/{swapId}/approve routes the officer decision through Cedar and returns 403 on a Cedar deny', async () => {
    const requestedAt = 1_800_000_650;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);
    authzSend.mockResolvedValue({ decision: Decision.DENY });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'OFFICER',
        sub: 'chief-1',
        authorization: 'Bearer token',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(authzSend).toHaveBeenCalledTimes(1);
  });

  it('POST /shifts/{id}/swap/{swapId}/approve returns 503 (fail-closed) and logs the original error when Verified Permissions is unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requestedAt = 1_800_000_660;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);
    authzSend.mockRejectedValue(new Error('Verified Permissions unavailable'));
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'OFFICER',
        sub: 'chief-1',
        authorization: 'Bearer token',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('shifts.swap.approve.authz_unavailable'),
    );
  });

  it('AC3: POST /shifts/{id}/swap/{swapId}/approve self-accept by the target member transfers without officer role', async () => {
    const requestedAt = 1_800_000_700;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: false,
        requestedAt,
      },
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'MEMBER',
        sub: 'member-2',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('POST /shifts/{id}/swap/{swapId}/approve self-accept by someone other than the target member returns 403', async () => {
    const requestedAt = 1_800_000_800;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-1' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'PENDING',
        requiresOfficerApproval: false,
        requestedAt,
      },
    ]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'MEMBER',
        sub: 'member-9',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('POST /shifts/{id}/swap/{swapId}/approve returns 404 when the swap does not exist', async () => {
    mockFakeDoc([buildDutyShift(VERIFIED_DEPT_ID, 'shift-1')]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap/1800000900/approve',
        body: undefined,
        groups: 'OFFICER',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('POST /shifts/{id}/swap/{swapId}/approve with a non-numeric swapId returns 400', async () => {
    mockFakeDoc([]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/swap/not-a-number/approve',
        body: undefined,
        groups: 'OFFICER',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('POST /shifts/{id}/swap/{swapId}/approve returns 409 when the swap is already resolved (not PENDING)', async () => {
    const requestedAt = 1_800_001_000;
    mockFakeDoc([
      buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
      buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', { claimedByMemberId: 'member-2' }),
      {
        pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'member-1',
        toMemberId: 'member-2',
        status: 'APPROVED',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);
    authzSend.mockResolvedValue({ decision: Decision.ALLOW });
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: `/api/v1/personnel/shifts/shift-1/swap/${requestedAt}/approve`,
        body: undefined,
        groups: 'OFFICER',
        authorization: 'Bearer token',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('returns 500 when the authorizer deptId claim is malformed on the release route', async () => {
    mockFakeDoc([]);
    const { handler } = await import('./handler.js');
    const result = await handler(
      buildEvent({
        rawPath: '/api/v1/personnel/shifts/shift-1/release',
        body: JSON.stringify({ positionCode: 'DRIVER' }),
        deptId: 'dept#001',
      }),
      {} as never,
      () => undefined,
    );
    expect(result).toMatchObject({ statusCode: 500 });
  });

  describe('POST .../shifts/{id}/claim', () => {
    it('AC1: atomically claims an open SHIFT_POSITION via a conditional update', async () => {
      mockFakeDoc([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER'),
      ]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          rawPath: '/api/v1/personnel/shifts/shift-1/claim',
          body: JSON.stringify({ positionCode: 'DRIVER' }),
          sub: 'member-1',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 201 });
      const body = JSON.parse((result as { body: string }).body) as {
        claimedByMemberId: string;
      };
      expect(body.claimedByMemberId).toBe('member-1');
    });

    it('never uses BatchWriteItem for the claim (test note): only Get/TransactWrite commands are issued', async () => {
      const fakeDoc = createFakeDocumentClient([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER'),
      ]);
      const sendSpy = vi.spyOn(fakeDoc, 'send');
      vi.doMock('./dynamoClient.js', () => ({
        getDocClient: () => fakeDoc,
        readPersonnelTableConfig: () => ({ tableName: 'platform-service' }),
      }));
      const { handler } = await import('./handler.js');
      await handler(
        buildEvent({
          rawPath: '/api/v1/personnel/shifts/shift-1/claim',
          body: JSON.stringify({ positionCode: 'DRIVER' }),
          sub: 'member-1',
        }),
        {} as never,
        () => undefined,
      );
      for (const call of sendSpy.mock.calls) {
        const commandName = (call[0] as { constructor: { name: string } }).constructor.name;
        expect(commandName).not.toBe('BatchWriteCommand');
      }
    });

    it('AC2: returns 409 with no double-booking when the position is already claimed', async () => {
      mockFakeDoc([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', {
          claimedByMemberId: 'member-2',
        }),
      ]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          rawPath: '/api/v1/personnel/shifts/shift-1/claim',
          body: JSON.stringify({ positionCode: 'DRIVER' }),
          sub: 'member-1',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 409 });
    });

    it('returns 404 when the shift position does not exist', async () => {
      mockFakeDoc([buildDutyShift(VERIFIED_DEPT_ID, 'shift-1')]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          rawPath: '/api/v1/personnel/shifts/shift-1/claim',
          body: JSON.stringify({ positionCode: 'DRIVER' }),
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 404 });
    });

    it('returns 400 when positionCode is missing', async () => {
      mockFakeDoc([]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          rawPath: '/api/v1/personnel/shifts/shift-1/claim',
          body: JSON.stringify({}),
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 400 });
    });
  });

  describe('GET .../shifts/{id}', () => {
    it('returns the shift with positions and claim state, including claimedByMe for the caller', async () => {
      mockFakeDoc([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'DRIVER', {
          claimedByMemberId: 'member-1',
        }),
        buildShiftPosition(VERIFIED_DEPT_ID, 'shift-1', 'FF1'),
      ]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          method: 'GET',
          rawPath: '/api/v1/personnel/shifts/shift-1',
          body: undefined,
          sub: 'member-1',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        shiftId: string;
        positions: { positionCode: string; claimedByMemberId?: string; claimedByMe?: boolean }[];
      };
      expect(body.shiftId).toBe('shift-1');
      expect(body.positions).toEqual([
        { positionCode: 'DRIVER', claimedByMemberId: 'member-1', claimedByMe: true },
        { positionCode: 'FF1' },
      ]);
    });

    it('returns 404 when the shift does not exist', async () => {
      mockFakeDoc([]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          method: 'GET',
          rawPath: '/api/v1/personnel/shifts/shift-missing',
          body: undefined,
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 404 });
    });
  });

  describe('GET .../shifts/swaps/mine', () => {
    it('returns only pending swaps where the caller is the proposer or the target', async () => {
      mockFakeDoc([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        {
          pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
          sk: 'SWAP#1',
          entityType: 'SHIFT_SWAP_REQUEST',
          shiftId: 'shift-1',
          positionCode: 'DRIVER',
          fromMemberId: 'member-1',
          toMemberId: 'member-2',
          status: 'PENDING',
          requiresOfficerApproval: true,
          requestedAt: 1,
        },
        {
          pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
          sk: 'SWAP#2',
          entityType: 'SHIFT_SWAP_REQUEST',
          shiftId: 'shift-1',
          positionCode: 'FF1',
          fromMemberId: 'member-9',
          toMemberId: 'member-8',
          status: 'PENDING',
          requiresOfficerApproval: true,
          requestedAt: 2,
        },
      ]);
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          method: 'GET',
          rawPath: '/api/v1/personnel/shifts/swaps/mine',
          body: undefined,
          sub: 'member-2',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        swaps: { requestedAt: number }[];
      };
      expect(body.swaps.map((swap) => swap.requestedAt)).toEqual([1]);
    });
  });

  describe('GET .../shifts/swaps/pending', () => {
    it('rejects a non-officer with 403 on a Cedar deny', async () => {
      mockFakeDoc([buildDutyShift(VERIFIED_DEPT_ID, 'shift-1')]);
      authzSend.mockResolvedValue({ decision: Decision.DENY });
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          method: 'GET',
          rawPath: '/api/v1/personnel/shifts/swaps/pending',
          body: undefined,
          groups: 'MEMBER',
          authorization: 'Bearer token',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 403 });
    });

    it('returns pending swaps that require officer approval when Cedar allows', async () => {
      mockFakeDoc([
        buildDutyShift(VERIFIED_DEPT_ID, 'shift-1'),
        {
          pk: `DEPT#${DEPT_ID}#SHIFT#shift-1`,
          sk: 'SWAP#1',
          entityType: 'SHIFT_SWAP_REQUEST',
          shiftId: 'shift-1',
          positionCode: 'DRIVER',
          fromMemberId: 'member-1',
          toMemberId: 'member-2',
          status: 'PENDING',
          requiresOfficerApproval: true,
          requestedAt: 1,
        },
      ]);
      authzSend.mockResolvedValue({ decision: Decision.ALLOW });
      const { handler } = await import('./handler.js');
      const result = await handler(
        buildEvent({
          method: 'GET',
          rawPath: '/api/v1/personnel/shifts/swaps/pending',
          body: undefined,
          groups: 'OFFICER',
          authorization: 'Bearer token',
        }),
        {} as never,
        () => undefined,
      );
      expect(result).toMatchObject({ statusCode: 200 });
      const body = JSON.parse((result as { body: string }).body) as {
        swaps: { requestedAt: number }[];
      };
      expect(body.swaps.map((swap) => swap.requestedAt)).toEqual([1]);
    });
  });
});
