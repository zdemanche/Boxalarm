import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'inspector',
};

function buildEvent(
  queryStringParameters: Record<string, string> | undefined,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'GET /api/v1/inspections',
    rawPath: '/api/v1/inspections',
    rawQueryString: '',
    headers,
    queryStringParameters,
    requestContext: { authorizer: { lambda: principal ?? undefined } },
  } as unknown as GuardEvent;
}

function vpClientDeciding(decision: 'ALLOW' | 'DENY'): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockResolvedValue({ decision: Decision[decision] }),
  } as unknown as VerifiedPermissionsClient;
}

function vpClientRejecting(): VerifiedPermissionsClient {
  return {
    send: vi.fn().mockRejectedValue(new Error('VP outage')),
  } as unknown as VerifiedPermissionsClient;
}

interface FakeDynamoClient {
  readonly client: DynamoDBDocumentClient;
  readonly send: ReturnType<typeof vi.fn>;
}

function fakeDynamoClient(itemsByGsi2pk: Record<string, unknown[]>): FakeDynamoClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      const pk = values[':gsi2pkValue'] ?? '';
      return Promise.resolve({ Items: itemsByGsi2pk[pk] ?? [] });
    }
    throw new Error(`unexpected command: ${JSON.stringify(command)}`);
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

function throwingDynamoClient(): FakeDynamoClient {
  const send = vi.fn().mockRejectedValue(new Error('Dynamo throttled'));
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

function item(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#dept-001#OCCUPANCY#OCC-1',
    sk: 'INSPECTION#INS-1',
    entityType: 'INSPECTION_RECORD',
    scheduledDate: '2026-10-05',
    violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
    nextDueDate: '2026-10-05',
    gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
    gsi2sk: '2026-10-05#INS-1',
    ...overrides,
  };
}

async function loadHandler(
  vpClient: VerifiedPermissionsClient,
  dynamo: FakeDynamoClient,
): Promise<typeof import('./handler.js')> {
  const authz = await import('@boxalarm/authz');
  authz.createAuthzClient(process.env, vpClient);
  const { getDocumentClient } = await import('../dynamoClient.js');
  getDocumentClient(dynamo.client);
  return import('./handler.js');
}

describe('listInspections handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('queries GSI2 for the given month, filters/sorts by due date within the lead window, and surfaces violation status (AC3, AC4)', async () => {
    const early = item({ gsi2sk: '2026-10-05#INS-1', sk: 'INSPECTION#INS-1' });
    const late = item({
      gsi2sk: '2026-10-20#INS-2',
      sk: 'INSPECTION#INS-2',
      pk: 'DEPT#dept-001#OCCUPANCY#OCC-2',
    });
    const dynamo = fakeDynamoClient({
      'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10': [late, early],
    });
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ month: '2026-10', leadDays: '25' }));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      items: { inspectionId: string; violations: { status: string }[] }[];
    };
    expect(body.items.map((i) => i.inspectionId)).toEqual(['INS-1', 'INS-2']);
    expect(body.items[0]!.violations[0]!.status).toBe('open');
  });

  it('returns 200 with an empty list when no inspections are due in the window', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ month: '2026-10' }));

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('denies with 401 on a missing bearer token or invalid principal', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const noToken = await handler(buildEvent(undefined, {}));
    const noPrincipal = await handler(
      buildEvent(undefined, { authorization: 'Bearer token' }, null),
    );

    expect(noToken).toMatchObject({ statusCode: 401 });
    expect(noPrincipal).toMatchObject({ statusCode: 401 });
  });

  it('returns 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientRejecting(), dynamo);

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(dynamo.send).not.toHaveBeenCalled();
  });

  it('returns 503 fail-closed and logs the original error when the DynamoDB Query is throttled/unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dynamo = throwingDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inspections.list.queryFailed'));
    errorSpy.mockRestore();
  });

  it('returns 400 validationProblem for a NaN-producing leadDays', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ leadDays: 'abc' }));

    expect(result).toMatchObject({ statusCode: 400 });
    expect(dynamo.send).not.toHaveBeenCalled();
  });

  it('queries every intermediate month partition for a leadDays window spanning 3+ calendar months', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    await handler(buildEvent({ month: '2026-01', leadDays: '65' }));

    const queriedPks = dynamo.send.mock.calls.map((call) => {
      const command = call[0] as QueryCommand;
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      return values[':gsi2pkValue'];
    });
    expect(queriedPks).toEqual(
      expect.arrayContaining([
        'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-01',
        'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-02',
        'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-03',
      ]),
    );
  });

  it('never derives the GSI2 partition deptId from a query param — only the verified principal (tenancy boundary)', async () => {
    const dynamo = fakeDynamoClient({});
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    await handler(buildEvent({ month: '2026-10', deptId: 'dept-injected' }));

    const queryCall = dynamo.send.mock.calls[0]![0] as QueryCommand;
    const values = queryCall.input.ExpressionAttributeValues as Record<string, string>;
    expect(values[':gsi2pkValue']).toBe('DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10');
  });
});
