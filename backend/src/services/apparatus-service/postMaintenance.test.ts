import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
  body: string | undefined,
  unitId: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/maintenance',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/maintenance`,
    rawQueryString: '',
    headers,
    pathParameters: unitId !== undefined ? { unitId } : undefined,
    body,
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

function fakeDynamoClient(options: {
  readonly apparatusExists: boolean;
  readonly putError?: Error;
}): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      return Promise.resolve(options.apparatusExists ? { Item: { pk: 'x', sk: 'METADATA' } } : {});
    }
    if (command instanceof PutCommand) {
      return options.putError ? Promise.reject(options.putError) : Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

const NOW = () => 1798052000;

function findPutItem(client: DynamoDBDocumentClient): Record<string, unknown> {
  const call = (client.send as ReturnType<typeof vi.fn>).mock.calls.find(
    (call: unknown[]) => call[0] instanceof PutCommand,
  ) as [PutCommand] | undefined;
  return call?.[0].input.Item as Record<string, unknown>;
}

async function importHandler() {
  const { createPostMaintenanceHandler } = await import('./postMaintenance.js');
  return createPostMaintenanceHandler;
}

describe('postMaintenance handler', () => {
  it('returns 401 unauthorized when the bearer token is missing', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2', PRINCIPAL, {}));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 401 unauthorized when the principal is missing', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2', null));
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('returns 403 forbidden on a Cedar deny', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('DENY'),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient(new Error('VP outage')),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 404 apparatus-not-found when no apparatus exists for the department/unit', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: false }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ description: 'Brake service', vendor: 'Acme', cost: 450 });
    const result = await handler(buildEvent(body, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 validation-error with a field-level errors array when required fields are missing', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{}', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body) as { errors: unknown[] };
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('returns 400 validation-error on an empty body', async () => {
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(undefined, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 and logs the original parse error on malformed JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{not json', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MalformedJson'));
    errorSpy.mockRestore();
  });

  it('propagates (does not swallow) a PutItem failure, logging the original error first', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const putError = new Error('table throttled');
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true, putError }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ description: 'Brake service', vendor: 'Acme', cost: 450 });
    await expect(handler(buildEvent(body, 'ENGINE-2'))).rejects.toThrow('table throttled');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('table throttled'));
    errorSpy.mockRestore();
  });

  it('emits a MaintenanceRecordLogFailed business metric before rethrowing a PutItem failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: fakeDynamoClient({ apparatusExists: true, putError: new Error('table throttled') }),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ description: 'Brake service', vendor: 'Acme', cost: 450 });
    await expect(handler(buildEvent(body, 'ENGINE-2'))).rejects.toThrow('table throttled');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MaintenanceRecordLogFailed'));
  });

  it('creates a MAINTENANCE_RECORD with description/vendor/cost, no gsi2pk/gsi2sk when scheduledNextAt is absent, and emits the MaintenanceRecordLogged business metric (AC1)', async () => {
    const dynamoClient = fakeDynamoClient({ apparatusExists: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createPostMaintenanceHandler = await importHandler();
    const handler = createPostMaintenanceHandler({
      client: dynamoClient,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ description: 'Brake service', vendor: 'Acme', cost: 450 });
    const result = await handler(buildEvent(body, 'ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 201 });
    const putItem = findPutItem(dynamoClient);
    expect(putItem.entityType).toBe('MAINTENANCE_RECORD');
    expect(putItem.description).toBe('Brake service');
    expect(putItem.vendor).toBe('Acme');
    expect(putItem.cost).toBe(450);
    expect(putItem.gsi2pk).toBeUndefined();
    expect(putItem.gsi2sk).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MaintenanceRecordLogged'));
  });

  it('never shares a pk/gsi2pk between two principals in different departments for the same unitId (core-harm)', async () => {
    const scheduledNextAt = NOW() + 1;
    const body = JSON.stringify({ description: 'x', vendor: 'y', cost: 1, scheduledNextAt });
    const createPostMaintenanceHandler = await importHandler();

    const clientA = fakeDynamoClient({ apparatusExists: true });
    const handlerA = createPostMaintenanceHandler({
      client: clientA,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    await handlerA(
      buildEvent(body, 'ENGINE-2', { sub: 'a', deptId: 'dept-a', 'cognito:groups': 'apparatus' }),
    );

    const clientB = fakeDynamoClient({ apparatusExists: true });
    const handlerB = createPostMaintenanceHandler({
      client: clientB,
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    await handlerB(
      buildEvent(body, 'ENGINE-2', { sub: 'b', deptId: 'dept-b', 'cognito:groups': 'apparatus' }),
    );

    const itemA = findPutItem(clientA);
    const itemB = findPutItem(clientB);

    expect(itemA.pk).not.toBe(itemB.pk);
    expect(itemA.gsi2pk).not.toBe(itemB.gsi2pk);
  });
});
