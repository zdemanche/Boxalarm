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

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'apparatus',
};

function buildEvent(
  withinDays: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/testing-schedules',
    rawPath: '/api/v1/apparatus/testing-schedules',
    rawQueryString: withinDays ? `withinDays=${withinDays}` : '',
    headers,
    queryStringParameters: withinDays !== undefined ? { withinDays } : undefined,
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

function scbaItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#dept-001#SCBA#SCBA-001',
    sk: 'METADATA',
    entityType: 'SCBA_RECORD',
    scbaUnitId: 'SCBA-001',
    apparatusId: 'ENGINE-2',
    cylinderId: 'CYL-0891',
    flowTestDate: '2026-01-01',
    hydroTestDate: '2026-06-01',
    nextFlowTestDue: '2026-09-20',
    nextHydroTestDue: '2030-12-31',
    gsi2pk: 'DEPT#dept-001#DUE#SCBA_TEST#2026-09',
    gsi2sk: '2026-09-20#SCBA-001',
    ...overrides,
  };
}

function fakeDynamoClient(itemsByGsi2pk: Record<string, Record<string, unknown>[]>): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      const gsi2pk = command.input.ExpressionAttributeValues?.[':pk'] as string;
      return Promise.resolve({ Items: itemsByGsi2pk[gsi2pk] ?? [] });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

async function importHandler() {
  const { createGetScbaTestingSchedulesHandler } = await import('./getScbaTestingSchedules.js');
  return createGetScbaTestingSchedulesHandler;
}

describe('getScbaTestingSchedules handler', () => {
  it('returns 403 forbidden on a Cedar deny', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('DENY'),
    });
    const result = await handler(buildEvent(undefined));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient(new Error('VP outage')),
    });
    const result = await handler(buildEvent(undefined));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 400 when withinDays is not a finite number', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('not-a-number'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 200 with an empty dueSoon array when no SCBA units are due (AC2)', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent(undefined));
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { dueSoon: unknown[] };
    expect(body.dueSoon).toEqual([]);
  });

  it('surfaces a unit due within the default 30-day window via the GSI2 due-date index (AC2)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const client = fakeDynamoClient({
      'DEPT#dept-001#DUE#SCBA_TEST#2026-09': [scbaItem({ gsi2sk: '2026-09-20#SCBA-001' })],
    });
    const createHandler = await importHandler();
    const handler = createHandler({ client, authzClient: fakeAuthzClient('ALLOW') });
    const result = await handler(buildEvent(undefined));

    const body = JSON.parse((result as { body: string }).body) as {
      dueSoon: { scbaUnitId: string }[];
    };
    expect(body.dueSoon).toHaveLength(1);
    expect(body.dueSoon[0]?.scbaUnitId).toBe('SCBA-001');
    vi.useRealTimers();
  });

  it('excludes a unit whose due date is outside the withinDays window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const client = fakeDynamoClient({
      'DEPT#dept-001#DUE#SCBA_TEST#2026-09': [scbaItem({ gsi2sk: '2026-09-30#SCBA-002' })],
    });
    const createHandler = await importHandler();
    const handler = createHandler({ client, authzClient: fakeAuthzClient('ALLOW') });
    const result = await handler(buildEvent('7'));

    const body = JSON.parse((result as { body: string }).body) as { dueSoon: unknown[] };
    expect(body.dueSoon).toEqual([]);
    vi.useRealTimers();
  });

  it('returns 503 fail-closed (not a silent empty success) when the GSI2 query fails', async () => {
    const failure = new Error('DynamoDB unavailable');
    const client = { send: vi.fn().mockRejectedValue(failure) } as unknown as DynamoDBDocumentClient;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createHandler = await importHandler();
    const handler = createHandler({ client, authzClient: fakeAuthzClient('ALLOW') });

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DynamoDB unavailable'));
    errorSpy.mockRestore();
  });
});
