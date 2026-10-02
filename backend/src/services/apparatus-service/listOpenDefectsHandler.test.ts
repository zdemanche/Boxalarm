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

const OFFICER: CedarPrincipalContext = {
  sub: 'officer-1',
  deptId: 'dept-001',
  'cognito:groups': 'officer',
};

function buildEvent(
  queryStringParameters: Record<string, string> | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = OFFICER,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/apparatus/defects',
    rawPath: '/api/v1/apparatus/defects',
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    queryStringParameters,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

function fakeAuthzClient(decision: 'ALLOW' | 'DENY' = 'ALLOW'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

const DEFECT_ROW = {
  defectId: 'DEF-1',
  apparatusId: 'APP-E1',
  unitId: 'E1',
  description: 'Pump will not engage',
  severity: 'OUT_OF_SERVICE',
  status: 'OPEN',
  reportedAt: 1_750_000_000,
  gsi3pk: 'DEPT#dept-001#DEFECT',
  gsi3sk: 'OPEN#1750000000',
};

async function importHandler() {
  const { createListOpenDefectsHandler } = await import('./listOpenDefectsHandler.js');
  return createListOpenDefectsHandler;
}

describe('listOpenDefectsHandler (entrypoint)', () => {
  it('returns every open defect in the department from one GSI3 query, never a Scan', async () => {
    const createHandler = await importHandler();
    const send = vi.fn((command: unknown) => {
      expect(command).toBeInstanceOf(QueryCommand);
      const input = (command as QueryCommand).input;
      expect(input.IndexName).toBe('GSI3');
      expect(input.KeyConditionExpression).toContain('begins_with');
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':gsi3pk': 'DEPT#dept-001#DEFECT',
        ':open': 'OPEN#',
      });
      return Promise.resolve({ Items: [DEFECT_ROW] });
    });
    const handler = createHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient(),
    });

    const result = (await handler(buildEvent({ status: 'open' }))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.body) as { defects: Record<string, unknown>[] };
    expect(body.defects).toEqual([
      {
        defectId: 'DEF-1',
        apparatusId: 'APP-E1',
        unitId: 'E1',
        description: 'Pump will not engage',
        severity: 'OUT_OF_SERVICE',
        reportedAt: 1_750_000_000,
        photoS3Key: null,
        itemCode: null,
      },
    ]);
  });

  it('follows pagination across GSI3 pages and returns all rows', async () => {
    const createHandler = await importHandler();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [DEFECT_ROW],
        LastEvaluatedKey: { gsi3pk: 'DEPT#dept-001#DEFECT', gsi3sk: 'OPEN#1750000000' },
      })
      .mockResolvedValueOnce({
        Items: [{ ...DEFECT_ROW, defectId: 'DEF-2', severity: 'MINOR' }],
      });
    const handler = createHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient(),
    });

    const result = (await handler(buildEvent({ status: 'open' }))) as { body: string };

    expect(send).toHaveBeenCalledTimes(2);
    const body = JSON.parse(result.body) as { defects: { defectId: string }[] };
    expect(body.defects.map((d) => d.defectId)).toEqual(['DEF-1', 'DEF-2']);
  });

  it('refuses anything but status=open with 400 (an honest contract, not a silent default)', async () => {
    const createHandler = await importHandler();
    const send = vi.fn();
    const handler = createHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient(),
    });

    for (const query of [undefined, {}, { status: 'resolved' }]) {
      const result = await handler(buildEvent(query));
      expect(result).toMatchObject({ statusCode: 400 });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 403 on a Cedar deny, before any DynamoDB call', async () => {
    const createHandler = await importHandler();
    const send = vi.fn();
    const handler = createHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient('DENY'),
    });

    const result = await handler(buildEvent({ status: 'open' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps a DynamoDB failure to 503, logged with the traceId', async () => {
    const createHandler = await importHandler();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    const handler = createHandler({
      client: { send } as unknown as DynamoDBDocumentClient,
      authzClient: fakeAuthzClient(),
    });

    const result = await handler(buildEvent({ status: 'open' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
