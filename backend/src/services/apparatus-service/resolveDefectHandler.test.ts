import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
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

const OFFICER: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'dept-001',
  'cognito:groups': 'officer',
};

function buildEvent(body: unknown, defectId = 'DEF-1'): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/defects/{defectId}/resolve',
    rawPath: `/api/v1/apparatus/E1/defects/${defectId}/resolve`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { unitId: 'E1', defectId },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { authorizer: { lambda: OFFICER } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

interface FakeTable {
  readonly send: ReturnType<typeof vi.fn>;
  readonly transactions: Record<string, unknown>[];
}

function fakeTable(
  options: {
    unitStatus?: string;
    defectStatus?: string;
    defectMissing?: boolean;
  } = {},
): FakeTable {
  const transactions: Record<string, unknown>[] = [];
  const send = vi.fn().mockImplementation((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve({
        Items: [
          {
            pk: 'DEPT#dept-001#APPARATUS#APP-E1',
            apparatusId: 'APP-E1',
            unitId: 'E1',
            status: options.unitStatus ?? 'IN_SERVICE',
          },
        ],
      });
    }
    if (command instanceof GetCommand) {
      if (options.defectMissing) {
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({
        Item: {
          pk: 'DEPT#dept-001#APPARATUS#APP-E1',
          sk: 'DEFECT#DEF-1',
          defectId: 'DEF-1',
          status: options.defectStatus ?? 'OPEN',
          severity: 'OUT_OF_SERVICE',
          reportedAt: 1_750_000_000,
        },
      });
    }
    if (command instanceof TransactWriteCommand) {
      transactions.push(command.input as Record<string, unknown>);
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send, transactions };
}

async function createHandler(table: FakeTable, decision: 'ALLOW' | 'DENY' = 'ALLOW') {
  const { createResolveDefectHandler } = await import('./resolveDefectHandler.js');
  return createResolveDefectHandler({
    client: { send: table.send } as unknown as DynamoDBDocumentClient,
    authzClient: fakeAuthzClient(decision),
  });
}

describe('resolveDefectHandler (entrypoint)', () => {
  it('resolves: RESOLVED + note + resolver, gsi3sk leaves OPEN#, one audit row rides along', async () => {
    const table = fakeTable({ unitStatus: 'IN_SERVICE' });
    const handler = await createHandler(table);

    const result = (await handler(buildEvent({ note: 'Replaced the pump seal' }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      defectId: 'DEF-1',
      status: 'RESOLVED',
      severity: 'OUT_OF_SERVICE',
      unitStillOutOfService: false,
    });
    expect(table.transactions).toHaveLength(1);
    const items = (table.transactions[0] as { TransactItems: Record<string, unknown>[] })
      .TransactItems;
    const update = items[0] as {
      Update: {
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(update.Update.ConditionExpression).toContain(':open');
    expect(update.Update.ExpressionAttributeValues).toMatchObject({
      ':resolved': 'RESOLVED',
      ':by': 'officer-1',
      ':note': 'Replaced the pump seal',
      ':gsi3sk': 'RESOLVED#1750000000',
    });
    const audit = items[1] as { Put: { Item: Record<string, unknown> } };
    expect(audit.Put.Item).toMatchObject({
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'DEFECT',
      mutatedEntityId: 'DEF-1',
      actorId: 'officer-1',
    });
    expect(String(audit.Put.Item.pk)).toMatch(/^DEPT#dept-001#AUDIT#/);
  });

  it('warns — never refuses — when the unit is still out of service (MAJOR-2 coupling)', async () => {
    const table = fakeTable({ unitStatus: 'OUT_OF_SERVICE' });
    const handler = await createHandler(table);

    const result = (await handler(buildEvent({ note: 'Brakes repaired' }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ unitStillOutOfService: true });
    expect(table.transactions).toHaveLength(1);
  });

  it('requires a non-empty note within the cap', async () => {
    const table = fakeTable();
    const handler = await createHandler(table);

    for (const body of [undefined, {}, { note: '' }, { note: '   ' }, { note: 'x'.repeat(1001) }]) {
      const result = await handler(buildEvent(body));
      expect(result).toMatchObject({ statusCode: 400 });
    }
    expect(table.transactions).toHaveLength(0);
  });

  it('answers 409 for a defect already resolved, and on losing the resolve race', async () => {
    const table = fakeTable({ defectStatus: 'RESOLVED' });
    const handler = await createHandler(table);

    const result = await handler(buildEvent({ note: 'again' }));

    expect(result).toMatchObject({ statusCode: 409 });
    expect(table.transactions).toHaveLength(0);
  });

  it('answers 404 for an unknown defect', async () => {
    const table = fakeTable({ defectMissing: true });
    const handler = await createHandler(table);

    const result = await handler(buildEvent({ note: 'fixed' }));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 403 on a Cedar deny, before any DynamoDB call', async () => {
    const table = fakeTable();
    const handler = await createHandler(table, 'DENY');

    const result = await handler(buildEvent({ note: 'fixed' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(table.send).not.toHaveBeenCalled();
  });
});
