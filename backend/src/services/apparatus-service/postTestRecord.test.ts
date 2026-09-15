import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
  body: string | undefined,
  unitId: string | undefined,
  principal: Partial<CedarPrincipalContext> | null | undefined = PRINCIPAL,
  headers: Record<string, string> = { authorization: 'Bearer token' },
): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/apparatus/{unitId}/tests',
    rawPath: `/api/v1/apparatus/${unitId ?? ''}/tests`,
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

function fakeApparatusRepository(apparatusId: string | undefined): ApparatusRepository {
  return {
    listApparatus: vi.fn(),
    createApparatus: vi.fn(),
    getApparatusDetail: vi.fn(),
    getApparatusByUnitId: vi
      .fn()
      .mockResolvedValue(
        apparatusId
          ? { apparatusId, unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' }
          : undefined,
      ),
  };
}

function fakeDynamoClient(putError?: Error): DynamoDBDocumentClient {
  const send = vi.fn((command: unknown) => {
    if (command instanceof PutCommand) {
      return putError ? Promise.reject(putError) : Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { send } as unknown as DynamoDBDocumentClient;
}

const NOW = () => '2026-09-14';

function findPutItem(client: DynamoDBDocumentClient): Record<string, unknown> {
  const call = (client.send as ReturnType<typeof vi.fn>).mock.calls.find(
    (call: unknown[]) => call[0] instanceof PutCommand,
  ) as [PutCommand] | undefined;
  return call?.[0].input.Item as Record<string, unknown>;
}

async function importHandler() {
  const { createPostTestRecordHandler } = await import('./postTestRecord.js');
  return createPostTestRecordHandler;
}

const VALID_BODY = JSON.stringify({
  testType: 'HOSE',
  result: 'PASS',
  nextDueDate: '2027-05-01',
});

describe('postTestRecord handler', () => {
  it('returns 403 forbidden when the bearer token is missing', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2', PRINCIPAL, {}));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 403 forbidden on a Cedar deny', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('DENY'),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns 503 fail-closed when Verified Permissions is unavailable', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient(new Error('VP outage')),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  it('returns 404 apparatus-not-found when no apparatus exists for the unitId', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository(undefined),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when testType is absent, not in the enum, or a number', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ testType: 4, result: 'PASS', nextDueDate: '2027-05-01' });
    const result = await handler(buildEvent(body, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when result is empty or not PASS/FAIL', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ testType: 'HOSE', result: '', nextDueDate: '2027-05-01' });
    const result = await handler(buildEvent(body, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 when nextDueDate is malformed', async () => {
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const body = JSON.stringify({ testType: 'HOSE', result: 'PASS', nextDueDate: '13/40/2026' });
    const result = await handler(buildEvent(body, 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 and logs the original parse error on malformed JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent('{not json', 'ENGINE-2'));
    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MalformedJson'));
    errorSpy.mockRestore();
  });

  it('defaults testDate to now() when absent', async () => {
    const dynamoClient = fakeDynamoClient();
    const createHandler = await importHandler();
    const handler = createHandler({
      client: dynamoClient,
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 201 });
    const putItem = findPutItem(dynamoClient);
    expect(putItem.testDate).toBe('2026-09-14');
    expect(putItem.sk).toBe('TEST#HOSE#2026-09-14');
  });

  it('propagates (does not swallow) a PutItem failure and emits TestRecordLogFailed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const putError = new Error('table throttled');
    const createHandler = await importHandler();
    const handler = createHandler({
      client: fakeDynamoClient(putError),
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    await expect(handler(buildEvent(VALID_BODY, 'ENGINE-2'))).rejects.toThrow('table throttled');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('table throttled'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('TestRecordLogFailed'));
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('persists an APPARATUS_TEST_RECORD keyed by the resolved apparatusId and emits TestRecordLogged (AC1)', async () => {
    const dynamoClient = fakeDynamoClient();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createHandler = await importHandler();
    const handler = createHandler({
      client: dynamoClient,
      apparatusRepository: fakeApparatusRepository('APP-ENGINE-2'),
      authzClient: fakeAuthzClient('ALLOW'),
      now: NOW,
    });
    const result = await handler(buildEvent(VALID_BODY, 'ENGINE-2'));

    expect(result).toMatchObject({ statusCode: 201 });
    const putItem = findPutItem(dynamoClient);
    expect(putItem.entityType).toBe('APPARATUS_TEST_RECORD');
    expect(putItem.pk).toBe('DEPT#dept-001#APPARATUS#APP-ENGINE-2');
    expect(putItem.testType).toBe('HOSE');
    expect(putItem.result).toBe('PASS');
    expect(putItem.nextDueDate).toBe('2027-05-01');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('TestRecordLogged'));
    logSpy.mockRestore();
  });
});
