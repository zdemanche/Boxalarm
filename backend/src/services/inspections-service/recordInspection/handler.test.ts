import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';

const PRINCIPAL: CedarPrincipalContext = {
  sub: 'member-1',
  deptId: 'dept-001',
  'cognito:groups': 'inspector',
};

function buildEvent(
  body: unknown,
  headers: Record<string, string> | undefined = { authorization: 'Bearer token' },
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/inspections',
    rawPath: '/api/v1/inspections',
    rawQueryString: '',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

interface DynamoBehavior {
  readonly occupancyExists?: boolean;
  readonly putBehavior?: 'succeed' | 'throw';
  readonly updateBehavior?: 'succeed' | 'conditionFailed' | 'throw';
}

interface FakeDynamoClient {
  readonly client: DynamoDBDocumentClient;
  readonly send: ReturnType<typeof vi.fn>;
}

function fakeDynamoClient(behavior: DynamoBehavior = {}): FakeDynamoClient {
  const { occupancyExists = true, putBehavior = 'succeed', updateBehavior = 'succeed' } = behavior;
  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      return Promise.resolve(occupancyExists ? { Item: { pk: 'p', sk: 'METADATA' } } : {});
    }
    if (command instanceof PutCommand) {
      if (putBehavior === 'throw') {
        throw new Error('Dynamo unavailable');
      }
      return Promise.resolve({});
    }
    if (command instanceof UpdateCommand) {
      if (updateBehavior === 'throw') {
        throw new Error('Dynamo unavailable');
      }
      if (updateBehavior === 'conditionFailed') {
        throw new ConditionalCheckFailedException({ message: 'cond failed', $metadata: {} });
      }
      const input = command.input;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      return Promise.resolve({
        Attributes: {
          pk: (input.Key as Record<string, unknown>).pk,
          sk: (input.Key as Record<string, unknown>).sk,
          entityType: 'INSPECTION_RECORD',
          scheduledDate: '2026-10-05',
          conductedDate: values[':conductedDate'],
          conductedBy: values[':conductedBy'],
          violations: values[':violations'],
          nextDueDate: '2026-10-05',
          gsi2pk: 'DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10',
          gsi2sk: '2026-10-05#INS-1',
        },
      });
    }
    throw new Error(`unexpected command: ${JSON.stringify(command)}`);
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
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

describe('recordInspection handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates an INSPECTION_RECORD with the occupancy-partition pk and DUE#INSPECTION_RECORD gsi2 keys (AC1)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' }));

    expect(result).toMatchObject({ statusCode: 201 });
    const putCall = dynamo.send.mock.calls.find((call) => call[0] instanceof PutCommand);
    const item = (putCall![0] as PutCommand).input.Item as Record<string, unknown>;
    expect(item.pk).toBe('DEPT#dept-001#OCCUPANCY#OCC-1');
    expect(item.gsi2pk).toBe('DEPT#dept-001#DUE#INSPECTION_RECORD#2026-10');
    expect(item.gsi2sk).toMatch(/^2026-10-05#/);
    expect(item.entityType).toBe('INSPECTION_RECORD');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('InspectionScheduled'));
    logSpy.mockRestore();
  });

  it('conduct writes conductedDate/conductedBy/violations onto the same item via a conditional UpdateItem, never a new PutItem (AC2)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(
      buildEvent({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        violations: [{ code: 'V1', description: 'bad wiring', status: 'open' }],
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as {
      occupancyId: string;
      inspectionId: string;
      conductedBy: string;
      violations: unknown[];
    };
    expect(body.occupancyId).toBe('OCC-1');
    expect(body.inspectionId).toBe('INS-1');
    expect(body.conductedBy).toBe('member-1');
    expect(body.violations).toEqual([{ code: 'V1', description: 'bad wiring', status: 'open' }]);
    expect(dynamo.send.mock.calls.some((call) => call[0] instanceof PutCommand)).toBe(false);
    const updateCall = dynamo.send.mock.calls.find((call) => call[0] instanceof UpdateCommand);
    expect((updateCall![0] as UpdateCommand).input.ConditionExpression).toBe(
      'attribute_exists(sk)',
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('InspectionConducted'));
    logSpy.mockRestore();
  });

  it('makes each violation status (open/resolved) visible in the conduct response (AC3)', async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(
      buildEvent({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        violations: [
          { code: 'V1', description: 'bad wiring', status: 'open' },
          { code: 'V2', description: 'fixed exit sign', status: 'resolved' },
        ],
      }),
    );

    const body = JSON.parse((result as { body: string }).body) as {
      violations: { status: string }[];
    };
    expect(body.violations.map((v) => v.status)).toEqual(['open', 'resolved']);
  });

  it('denies with 403 on a missing bearer token or invalid principal', async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const noToken = await handler(
      buildEvent({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' }, {}),
    );
    const noPrincipal = await handler(
      buildEvent(
        { occupancyId: 'OCC-1', scheduledDate: '2026-10-05' },
        { authorization: 'Bearer token' },
        null,
      ),
    );

    expect(noToken).toMatchObject({ statusCode: 403 });
    expect(noPrincipal).toMatchObject({ statusCode: 403 });
  });

  it('returns 503, never a defaulted allow, when Verified Permissions is unavailable (core-harm)', async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientRejecting(), dynamo);

    const result = await handler(buildEvent({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(dynamo.send).not.toHaveBeenCalled();
  });

  it('returns 400 validationProblem for an empty body / absent occupancyId+scheduledDate', async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent(undefined));

    expect(result).toMatchObject({ statusCode: 400 });
    expect((result as { headers: Record<string, string> }).headers['content-type']).toBe(
      'application/problem+json',
    );
  });

  it('returns 404 notFoundProblem when the schedule occupancyId references no OCCUPANCY item', async () => {
    const dynamo = fakeDynamoClient({ occupancyExists: false });
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(
      buildEvent({ occupancyId: 'OCC-missing', scheduledDate: '2026-10-05' }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 404 notFoundProblem when the conduct inspectionId references no INSPECTION_RECORD item', async () => {
    const dynamo = fakeDynamoClient({ updateBehavior: 'conditionFailed' });
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(
      buildEvent({ occupancyId: 'OCC-1', inspectionId: 'INS-missing', violations: [] }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 validationProblem for a wrong-typed violation (bad status enum, missing code)', async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const badStatus = await handler(
      buildEvent({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        violations: [{ code: 'V1', description: 'x', status: 'closed' }],
      }),
    );
    const missingCode = await handler(
      buildEvent({
        occupancyId: 'OCC-1',
        inspectionId: 'INS-1',
        violations: [{ description: 'x', status: 'open' }],
      }),
    );

    expect(badStatus).toMatchObject({ statusCode: 400 });
    expect(missingCode).toMatchObject({ statusCode: 400 });
  });

  it('returns 503 fail-closed, and logs the original error, when DynamoDB is throttled/unavailable (error-path-logging)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dynamo = fakeDynamoClient({ putBehavior: 'throw' });
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05' }));

    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('inspections.schedule.writeFailed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
    errorSpy.mockRestore();
  });

  it('logs and returns 400 validationProblem for a malformed JSON body instead of silently swallowing the parse error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const event = buildEvent({ occupancyId: 'OCC-1' });
    (event as { body: string }).body = '{not-json';

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('inspections.body.malformed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SyntaxError'));
    errorSpy.mockRestore();
  });

  it("returns 400 validationProblem, never an uncaught exception, when occupancyId contains '#' (tenancy delimiter guard)", async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(buildEvent({ occupancyId: 'OCC#1', scheduledDate: '2026-10-05' }));

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it("returns 400 validationProblem, never an uncaught exception, when conduct's occupancyId/inspectionId contain '#' (tenancy delimiter guard)", async () => {
    const dynamo = fakeDynamoClient();
    const { handler } = await loadHandler(vpClientDeciding('ALLOW'), dynamo);

    const result = await handler(
      buildEvent({ occupancyId: 'OCC-1', inspectionId: 'INS#1', violations: [] }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('never reads deptId from the request body — the pk and VP resourceId come only from the verified authorizer principal (tenancy boundary, core-harm)', async () => {
    const dynamo = fakeDynamoClient();
    const vpClient = vpClientDeciding('ALLOW');
    const { handler } = await loadHandler(vpClient, dynamo);

    await handler(
      buildEvent({ occupancyId: 'OCC-1', scheduledDate: '2026-10-05', deptId: 'dept-injected' }),
    );

    const putCall = dynamo.send.mock.calls.find((call) => call[0] instanceof PutCommand);
    const item = (putCall![0] as PutCommand).input.Item as Record<string, unknown>;
    expect(item.pk).toBe('DEPT#dept-001#OCCUPANCY#OCC-1');
    expect(JSON.stringify(item)).not.toContain('dept-injected');
  });
});
