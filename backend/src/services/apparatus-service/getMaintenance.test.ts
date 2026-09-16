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
  unitId: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/{unitId}/maintenance',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/maintenance`,
    rawQueryString: '',
    headers,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
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
  items: readonly Record<string, unknown>[] | Error,
): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return items instanceof Error ? Promise.reject(items) : Promise.resolve({ Items: items });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

async function importHandler() {
  const { createGetMaintenanceHandler } = await import('./getMaintenance.js');
  return createGetMaintenanceHandler;
}

describe('getMaintenance handler', () => {
  it('returns 401 unauthorized when the bearer token is missing', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([]),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('ENGINE-2', PRINCIPAL, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 401 unauthorized when the principal is missing', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([]),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('ENGINE-2', null));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 forbidden on a Cedar deny', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([]),
      authzClient: fakeAuthzClient('DENY'),
    });
    const result = await handler(buildEvent('ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([]),
      authzClient: fakeAuthzClient(new Error('VP outage')),
    });
    const result = await handler(buildEvent('ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 200 with empty records and null nextScheduled when no records exist (AC2)', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([]),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      records: unknown[];
      nextScheduled: number | null;
    };
    expect(body).toEqual({ records: [], nextScheduled: null });
  });

  it('propagates (does not swallow) a Query failure', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient(new Error('table throttled')),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await expect(handler(buildEvent('ENGINE-2'))).rejects.toThrow('table throttled');
  });

  it('returns past records and the next scheduled maintenance sorted most-recent-first (AC2)', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([
        {
          pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
          sk: 'MAINT#1798100000',
          entityType: 'MAINTENANCE_RECORD',
          description: 'Recent service',
          vendor: 'Acme',
          cost: 300,
          scheduledNextAt: 1798500000,
        },
        {
          pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
          sk: 'MAINT#1798052000',
          entityType: 'MAINTENANCE_RECORD',
          description: 'Older service',
          vendor: 'Acme',
          cost: 200,
          scheduledNextAt: null,
        },
      ]),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('ENGINE-2'));
    const body = JSON.parse((result as { body: string }).body) as {
      records: { performedAt: number }[];
      nextScheduled: number | null;
    };
    expect(body.records.map((r) => r.performedAt)).toEqual([1798100000, 1798052000]);
    expect(body.nextScheduled).toBe(1798500000);
  });

  it('derives nextScheduled from the most-recent record only, not the first non-null value', async () => {
    const createGetMaintenanceHandler = await importHandler();
    const handler = createGetMaintenanceHandler({
      client: fakeDynamoClient([
        {
          pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
          sk: 'MAINT#1798100000',
          entityType: 'MAINTENANCE_RECORD',
          description: 'Most recent, no plan yet',
          vendor: 'Acme',
          cost: 300,
          scheduledNextAt: null,
        },
        {
          pk: 'DEPT#dept-001#APPARATUS#ENGINE-2',
          sk: 'MAINT#1798052000',
          entityType: 'MAINTENANCE_RECORD',
          description: 'Older, had a plan',
          vendor: 'Acme',
          cost: 200,
          scheduledNextAt: 1798200000,
        },
      ]),
      authzClient: fakeAuthzClient('ALLOW'),
    });
    const result = await handler(buildEvent('ENGINE-2'));
    const body = JSON.parse((result as { body: string }).body) as { nextScheduled: number | null };
    expect(body.nextScheduled).toBeNull();
  });

  it('never shares a Query pk between two principals in different departments for the same unitId (core-harm)', async () => {
    const createGetMaintenanceHandler = await importHandler();

    const clientA = fakeDynamoClient([]);
    const handlerA = createGetMaintenanceHandler({
      client: clientA,
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await handlerA(
      buildEvent('ENGINE-2', { sub: 'a', deptId: 'dept-a', 'cognito:groups': 'apparatus' }),
    );

    const clientB = fakeDynamoClient([]);
    const handlerB = createGetMaintenanceHandler({
      client: clientB,
      authzClient: fakeAuthzClient('ALLOW'),
    });
    await handlerB(
      buildEvent('ENGINE-2', { sub: 'b', deptId: 'dept-b', 'cognito:groups': 'apparatus' }),
    );

    const queryA = (clientA.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as QueryCommand;
    const queryB = (clientB.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as QueryCommand;
    expect(queryA.input.ExpressionAttributeValues?.[':pk']).not.toBe(
      queryB.input.ExpressionAttributeValues?.[':pk'],
    );
  });
});
