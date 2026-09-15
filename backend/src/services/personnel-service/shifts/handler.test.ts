import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';

const DEPT_ID = 'dept-001';

function buildEvent(
  overrides: Partial<{
    method: string;
    path: string;
    body: string | undefined;
    groups: string;
    requestId: string;
    deptId: string;
  }> = {},
): APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext> {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/api/v1/personnel/shifts';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
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
          sub: 'member-1',
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
