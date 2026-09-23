import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import type { ApparatusRepository } from './apparatusRepository.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  queryStringParameters: Record<string, string> | undefined = undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/testing-schedules',
    rawPath: '/api/v1/apparatus/testing-schedules',
    rawQueryString: '',
    headers,
    queryStringParameters,
    requestContext: {
      authorizer: { lambda: principal ?? undefined },
    },
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

function fakeDynamoClient(items: Record<string, unknown>[]): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve({ Items: items });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeApparatusRepository(
  unitsByApparatusId: Record<string, string> = {},
): ApparatusRepository {
  return {
    getApparatusByUnitId: vi.fn(),
    createApparatus: vi.fn(),
    getApparatusDetail: vi.fn(),
    listApparatus: vi.fn().mockResolvedValue(
      Object.entries(unitsByApparatusId).map(([apparatusId, unitId]) => ({
        apparatusId,
        unitId,
        type: 'ENGINE',
        status: 'IN_SERVICE',
      })),
    ),
  };
}

const NOW = () => new Date('2026-09-14T00:00:00Z');

async function importHandler() {
  const { createGetTestingSchedulesHandler } = await import('./getTestingSchedules.js');
  return createGetTestingSchedulesHandler;
}

describe('getTestingSchedules handler', () => {
  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([]),
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient(new Error('VP outage')),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 403 forbidden on a Cedar deny', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([]),
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('DENY'),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 401 unauthorized when the bearer token is missing', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([]),
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(undefined, PRINCIPAL, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 200 with an empty list when nothing is due in the window', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([]),
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([]);
  });

  it('includes a newly-saved unit/testType in the due-date listing, resolving the real unitId rather than the internal apparatusId (AC1, regression coverage for the APP- prefix leak)', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([
        { apparatusId: 'APP-ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-20' },
      ]),
      apparatusRepository: fakeApparatusRepository({ 'APP-ENGINE-2': 'ENGINE-2' }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([
      { unitId: 'ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-20' },
    ]);
  });

  it('sorts results by nextDueDate', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient([
        { apparatusId: 'APP-LADDER-1', testType: 'LADDER', nextDueDate: '2026-10-01' },
        { apparatusId: 'APP-ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-25' },
      ]),
      apparatusRepository: fakeApparatusRepository({
        'APP-ENGINE-2': 'ENGINE-2',
        'APP-LADDER-1': 'LADDER-1',
      }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent({ monthsAhead: '1' }));
    expect(JSON.parse((result as { body: string }).body)).toEqual([
      { unitId: 'ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-25' },
      { unitId: 'LADDER-1', testType: 'LADDER', nextDueDate: '2026-10-01' },
    ]);
  });

  it('issues a single ranged GSI2 Query (not one per month) spanning [today, end-of-window]', async () => {
    const client = fakeDynamoClient([]);
    const createHandler = await importHandler();
    const handler = createHandler({
      client,
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });

    await handler(buildEvent({ monthsAhead: '2' }));

    const queryCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] instanceof QueryCommand,
    );
    expect(queryCalls).toHaveLength(1);
    const command = queryCalls[0]?.[0] as QueryCommand;
    expect(command.input.KeyConditionExpression).toBe(
      'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :start AND :end',
    );
    expect(command.input.ExpressionAttributeValues?.[':gsi2pk']).toBe(
      'DEPT#dept-001#DUE#APPARATUS_TEST',
    );
    expect(command.input.ExpressionAttributeValues?.[':start']).toBe('2026-09-14');
    // monthsAhead=2 from 2026-09-14 -> last day of 2026-11
    expect(command.input.ExpressionAttributeValues?.[':end']).toBe('2026-11-30#￿');
  });

  it('falls back to the default (24-month) window when the query param is NaN-producing', async () => {
    const client = fakeDynamoClient([]);
    const createHandler = await importHandler();
    const handler = createHandler({
      client,
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });

    await handler(buildEvent({ monthsAhead: 'abc' }));

    const command = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as QueryCommand;
    // 24 months from 2026-09-14 -> last day of 2028-09
    expect(command.input.ExpressionAttributeValues?.[':end']).toBe('2028-09-30#￿');
  });

  it('returns 503 (not an unhandled rejection) when the GSI2 query fails', async () => {
    const failure = new Error('DynamoDB unavailable');
    const client = {
      send: vi.fn().mockRejectedValue(failure),
    } as unknown as DynamoDBDocumentClient;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createHandler = await importHandler();
    const handler = createHandler({
      client,
      apparatusRepository: fakeApparatusRepository(),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });

    const result = await handler(buildEvent());

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
    errorSpy.mockRestore();
  });
});
