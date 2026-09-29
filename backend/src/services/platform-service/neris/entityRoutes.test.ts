import { beforeEach, describe, expect, it, vi } from 'vitest';

const { vpSend, ddbSend, syncEntity, lambdaSend } = vi.hoisted(() => ({
  vpSend: vi.fn(),
  ddbSend: vi.fn(),
  syncEntity: vi.fn(),
  lambdaSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return { ...actual, LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })) };
});

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vpSend })),
  };
});
vi.mock('../export/awsClients.js', () => ({ getDynamoDocClient: () => ({ send: ddbSend }) }));
vi.mock('../../incident-service/neris/index.js', () => ({
  getNerisClient: () => ({}),
  readNerisConfig: () => Promise.resolve({}),
}));
vi.mock('./entitySync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entitySync.js')>();
  return { ...actual, syncEntity };
});

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
process.env.PLATFORM_TABLE_NAME = 'platform-table';
process.env.NERIS_ENTITY_SYNC_WORKER = 'boxalarm-dev-platform-neris-entity-sync-worker';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler as putHandler } from './putEntity.js';
import { handler as getHandler } from './getEntity.js';

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

function event(body?: unknown) {
  return {
    headers: { authorization: 'Bearer token' },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: { lambda: { sub: 'chief-1', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' } },
    },
  } as never;
}

const VALID = {
  stations: [
    {
      stationId: 'STA1',
      addressLine1: '1 Firehouse Ln',
      city: 'Trumbull',
      state: 'CT',
      zipCode: '06611',
      units: [{ unitId: 'E1', type: 'ENGINE_STRUCT', staffing: 4 }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('PUT /platform/neris/entity', () => {
  it('authorizes SyncNerisEntity and rejects a malformed list with field errors', async () => {
    const result = (await putHandler(event({ stations: [] }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(400);
    expect((JSON.parse(result.body) as { errors: unknown }).errors).toEqual([
      { field: 'stations', message: 'is required and must be a non-empty array' },
    ]);
    expect(
      (vpSend.mock.calls[0]![0] as { input: { action: { actionId: string } } }).input.action
        .actionId,
    ).toBe('SyncNerisEntity');
  });

  it('refuses until the department NERIS id is configured', async () => {
    ddbSend.mockResolvedValue({});
    const result = (await putHandler(event(VALID))) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(409);
    expect((JSON.parse(result.body) as { code: string }).code).toBe('NOT_CONFIGURED');
    expect(syncEntity).not.toHaveBeenCalled();
  });

  it('starts the sync asynchronously: marks SYNCING, invokes the worker, answers 202', async () => {
    ddbSend.mockImplementation((command: Command) =>
      Promise.resolve(
        command.constructor.name === 'GetCommand' &&
          (command.input.Key as { sk: string }).sk === 'CONFIG#NERIS'
          ? { Item: { value: { departmentNerisId: 'FD09190828' } } }
          : {},
      ),
    );
    lambdaSend.mockResolvedValue({ StatusCode: 202 });
    const result = (await putHandler(event(VALID))) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(202);
    expect((JSON.parse(result.body) as { status: string }).status).toBe('SYNCING');
    const update = ddbSend.mock.calls
      .map(([c]) => c as Command)
      .find((c) => c.constructor.name === 'UpdateCommand')!;
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':syncing': 'SYNCING',
      ':request': VALID,
    });
    const invoke = (lambdaSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(invoke).toMatchObject({
      FunctionName: 'boxalarm-dev-platform-neris-entity-sync-worker',
      InvocationType: 'Event',
    });
    expect(syncEntity).not.toHaveBeenCalled();
  });

  it('releases the row as FAILED when the worker cannot be invoked', async () => {
    ddbSend.mockImplementation((command: Command) =>
      Promise.resolve(
        command.constructor.name === 'GetCommand' &&
          (command.input.Key as { sk: string }).sk === 'CONFIG#NERIS'
          ? { Item: { value: { departmentNerisId: 'FD09190828' } } }
          : {},
      ),
    );
    lambdaSend.mockRejectedValue(new Error('throttled'));
    const result = (await putHandler(event(VALID))) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    const updates = ddbSend.mock.calls
      .map(([c]) => c as Command)
      .filter((c) => c.constructor.name === 'UpdateCommand');
    expect(updates[1]!.input).toMatchObject({
      ConditionExpression: 'syncStatus = :syncing',
      ExpressionAttributeValues: expect.objectContaining({ ':failed': 'FAILED' }) as unknown,
    });
  });

  it('refuses a second sync while one is running', async () => {
    ddbSend.mockImplementation((command: Command) => {
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.reject(
          Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }),
        );
      }
      return Promise.resolve(
        (command.input.Key as { sk: string }).sk === 'CONFIG#NERIS'
          ? { Item: { value: { departmentNerisId: 'FD09190828' } } }
          : {},
      );
    });
    const result = (await putHandler(event(VALID))) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(409);
    expect((JSON.parse(result.body) as { code: string }).code).toBe('SYNC_RUNNING');
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});

describe('GET /platform/neris/entity', () => {
  it('reports NOT_SYNCED before the first sync, authorizing ViewNerisEntity', async () => {
    ddbSend.mockResolvedValue({});
    const result = (await getHandler(event())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      status: 'NOT_SYNCED',
      stations: [],
      units: [],
      errors: [],
    });
    expect(
      (vpSend.mock.calls[0]![0] as { input: { action: { actionId: string } } }).input.action
        .actionId,
    ).toBe('ViewNerisEntity');
  });

  it('reports PARTIAL when the last sync left errors', async () => {
    ddbSend.mockResolvedValue({
      Item: {
        departmentNerisId: 'FD09190828',
        stations: [],
        units: [],
        errors: [{ subject: 'unit T2', message: 'x' }],
        syncedAt: 't',
        syncedBy: 'chief-1',
      },
    });
    const result = (await getHandler(event())) as { body: string };
    expect((JSON.parse(result.body) as { status: string }).status).toBe('PARTIAL');
  });

  it('reports FAILED with the reason when the sync could not run', async () => {
    ddbSend.mockResolvedValue({
      Item: { syncStatus: 'FAILED', syncError: 'secret missing', syncFailedAt: 't2' },
    });
    const result = (await getHandler(event())) as { body: string };
    expect(JSON.parse(result.body)).toMatchObject({
      status: 'FAILED',
      syncError: 'secret missing',
    });
  });
});
