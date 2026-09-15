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

function fakeDynamoClient(
  itemsByMonth: Record<string, Record<string, unknown>[]>,
): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      const gsi2pk = command.input.ExpressionAttributeValues?.[':gsi2pk'] as string;
      const yearMonth = gsi2pk.slice(gsi2pk.lastIndexOf('#') + 1);
      return Promise.resolve({ Items: itemsByMonth[yearMonth] ?? [] });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
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
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient(new Error('VP outage')),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 200 with an empty list when nothing is due in the window', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({}),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([]);
  });

  it('includes a newly-saved unit/testType in the due-date listing (AC1)', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({
        '2026-09': [{ gsi2sk: '2026-09-20#APP-ENGINE-2#HOSE' }],
      }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent());
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual([
      { unitId: 'APP-ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-20' },
    ]);
  });

  it('sorts across month partitions by nextDueDate', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient({
        '2026-09': [{ gsi2sk: '2026-09-25#APP-ENGINE-2#HOSE' }],
        '2026-10': [{ gsi2sk: '2026-10-01#APP-LADDER-1#LADDER' }],
      }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: () => new Date('2026-09-14T00:00:00Z'),
    });
    const result = await handler(buildEvent({ monthsAhead: '1' }));
    expect(JSON.parse((result as { body: string }).body)).toEqual([
      { unitId: 'APP-ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-25' },
      { unitId: 'APP-LADDER-1', testType: 'LADDER', nextDueDate: '2026-10-01' },
    ]);
  });

  it('falls back to the default monthsAhead when the query param is NaN-producing', async () => {
    const client = fakeDynamoClient({});
    const createHandler = await importHandler();
    const handler = createHandler({ client, authzClient: fakeAuthzClient('ALLOW'), now: NOW });

    await handler(buildEvent({ monthsAhead: 'abc' }));

    const sendCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(sendCalls).toBe(25);
  });
});
