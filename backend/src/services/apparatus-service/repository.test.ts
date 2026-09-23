import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

const DEPT_ID = 'dept-001' as VerifiedDeptId;
const TABLE = 'platform-table';
const APP_PK = `DEPT#${DEPT_ID}#APPARATUS#APP-E1`;

interface TransactItemEntry {
  readonly Put?: { readonly Item?: Record<string, unknown> };
  readonly Update?: {
    readonly Key?: Record<string, unknown>;
    readonly UpdateExpression?: string;
  };
}

type Router = (command: unknown) => unknown;

function fakeClient(route: Router): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(route(command))),
  } as unknown as DynamoDBDocumentClient;
}

function registryLookup(command: unknown, item: Record<string, unknown> | undefined): unknown {
  if (command instanceof QueryCommand && command.input.IndexName === 'GSI3') {
    return { Items: item ? [item] : [] };
  }
  return undefined;
}

function lastTransactItems(send: ReturnType<typeof vi.fn>): TransactItemEntry[] {
  const call = send.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0] as
    TransactWriteCommand | undefined;
  return (call?.input.TransactItems ?? []) as TransactItemEntry[];
}

function findUpdate(items: TransactItemEntry[], sk: string): TransactItemEntry['Update'] {
  return items.find((item) => item.Update?.Key?.sk === sk)?.Update;
}

function findPut(items: TransactItemEntry[]): TransactItemEntry['Put'] {
  return items.find((item) => 'Put' in item)?.Put;
}

const ENGINE_METADATA = { pk: APP_PK, unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' };
const OOS_METADATA = { pk: APP_PK, unitId: 'E1', type: 'ENGINE', status: 'OUT_OF_SERVICE' };

describe('getApparatus', () => {
  it('returns the apparatus record when found', async () => {
    const { getApparatus } = await import('./repository.js');
    const client = fakeClient((command) => registryLookup(command, ENGINE_METADATA));

    const result = await getApparatus(client, TABLE, DEPT_ID, 'E1');
    expect(result).toEqual({ unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' });
  });

  it('returns undefined when the apparatus does not exist', async () => {
    const { getApparatus } = await import('./repository.js');
    const client = fakeClient((command) => registryLookup(command, undefined));

    expect(await getApparatus(client, TABLE, DEPT_ID, 'unknown')).toBeUndefined();
  });

  it('logs the original error (including error.message) and wraps a DynamoDB failure as ApparatusRepositoryUnavailableError (error-context)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getApparatus, ApparatusRepositoryUnavailableError } = await import('./repository.js');
    const client = fakeClient(() => {
      throw new Error('table not found');
    });

    await expect(getApparatus(client, TABLE, DEPT_ID, 'E1')).rejects.toBeInstanceOf(
      ApparatusRepositoryUnavailableError,
    );
    const logged = errorSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('apparatus.getApparatus.failed'));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged ?? '{}') as { errorMessage?: string };
    expect(parsed.errorMessage).toBe('table not found');
    errorSpy.mockRestore();
  });
});

describe('setServiceStatus', () => {
  it('resolves unitId to the apparatusId-keyed pk via GSI3 before writing, flips APPARATUS to OUT_OF_SERVICE, creates an open OUT_OF_SERVICE_RECORD with epoch-seconds startAt and no endAt, and denormalizes the summary onto METADATA (AC1, architecture pk shape)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { setServiceStatus } = await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, ENGINE_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof TransactWriteCommand) {
        return Promise.resolve({});
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    const before = Math.floor(Date.now() / 1000);
    await setServiceStatus(client, TABLE, {
      deptId: DEPT_ID,
      unitId: 'E1',
      status: 'OUT_OF_SERVICE',
      reason: 'Transmission failure',
    });

    const items = lastTransactItems(send);
    const put = findPut(items);
    expect(put?.Item).toMatchObject({
      pk: APP_PK,
      entityType: 'OUT_OF_SERVICE_RECORD',
      reason: 'Transmission failure',
    });
    expect(put?.Item?.endAt).toBeUndefined();
    const startAt = put?.Item?.startAt as number;
    expect(Number.isInteger(startAt)).toBe(true);
    expect(startAt).toBeGreaterThanOrEqual(before);
    expect(startAt).toBeLessThan(before + 1_000_000_000);
    expect(put?.Item?.sk).toBe(`OOS#${startAt}`);

    const statusUpdate = findUpdate(items, 'METADATA');
    expect(statusUpdate?.Key?.pk).toBe(APP_PK);
    expect(statusUpdate?.UpdateExpression).toContain('outOfServiceReason = :reason');
    expect(statusUpdate?.UpdateExpression).toContain('outOfServiceStartAt = :startAt');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('OutOfServiceRecorded'));
    logSpy.mockRestore();
  });

  it('closes the same open OUT_OF_SERVICE_RECORD (not a different one) and flips APPARATUS back to IN_SERVICE, clearing the denormalized summary (AC2, core-harm)', async () => {
    const { setServiceStatus } = await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, OOS_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [{ sk: 'OOS#1700000000', reason: 'Brake repair', startAt: 1700000000 }],
        });
      }
      if (command instanceof TransactWriteCommand) {
        return Promise.resolve({});
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await setServiceStatus(client, TABLE, { deptId: DEPT_ID, unitId: 'E1', status: 'IN_SERVICE' });

    const items = lastTransactItems(send);
    const closeUpdate = findUpdate(items, 'OOS#1700000000');
    expect(closeUpdate).toBeDefined();
    expect(closeUpdate?.UpdateExpression).toBe('SET endAt = :endAt');
    const statusUpdate = findUpdate(items, 'METADATA');
    expect(statusUpdate?.UpdateExpression).toBe(
      'SET #status = :next REMOVE outOfServiceReason, outOfServiceStartAt',
    );
  });

  it('closes the genuinely open record, not the oldest one, when a closed OOS cycle sorts ahead of it (Limit-before-filter regression, AC2)', async () => {
    const { setServiceStatus } = await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, OOS_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof QueryCommand) {
        const scanForward = command.input.ScanIndexForward;
        const limit = command.input.Limit;
        const all = [
          { sk: 'OOS#1600000000', reason: 'old repair', startAt: 1600000000, endAt: 1600001000 },
          { sk: 'OOS#1700000000', reason: 'current repair', startAt: 1700000000 },
        ];
        const ordered = scanForward === false ? [...all].reverse() : all;
        const page = typeof limit === 'number' ? ordered.slice(0, limit) : ordered;
        const filtered = page.filter((item) => !('endAt' in item));
        return Promise.resolve({ Items: filtered });
      }
      if (command instanceof TransactWriteCommand) {
        return Promise.resolve({});
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await setServiceStatus(client, TABLE, { deptId: DEPT_ID, unitId: 'E1', status: 'IN_SERVICE' });

    const closeUpdate = findUpdate(lastTransactItems(send), 'OOS#1700000000');
    expect(closeUpdate).toBeDefined();
  });

  it('rejects with 409-shaped conflict when the apparatus is already in the requested state, without writing', async () => {
    const { setServiceStatus, ServiceStatusConflictError } = await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, OOS_METADATA);
      if (lookup) return Promise.resolve(lookup);
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await expect(
      setServiceStatus(client, TABLE, {
        deptId: DEPT_ID,
        unitId: 'E1',
        status: 'OUT_OF_SERVICE',
        reason: 'still down',
      }),
    ).rejects.toBeInstanceOf(ServiceStatusConflictError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects with 409-shaped conflict when returning to service with no open OUT_OF_SERVICE_RECORD', async () => {
    const { setServiceStatus, ServiceStatusConflictError } = await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, OOS_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof QueryCommand) {
        return Promise.resolve({ Items: [] });
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await expect(
      setServiceStatus(client, TABLE, { deptId: DEPT_ID, unitId: 'E1', status: 'IN_SERVICE' }),
    ).rejects.toBeInstanceOf(ServiceStatusConflictError);
  });

  it('rejects with 404-shaped not-found when the apparatus unitId does not exist', async () => {
    const { setServiceStatus, ApparatusNotFoundError } = await import('./repository.js');
    const client = fakeClient((command) => registryLookup(command, undefined));

    await expect(
      setServiceStatus(client, TABLE, {
        deptId: DEPT_ID,
        unitId: 'missing',
        status: 'OUT_OF_SERVICE',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ApparatusNotFoundError);
  });

  it('logs the original error including error.message and CancellationReasons before mapping a transaction condition failure to 409 (error-context on the cancellation-reasons path)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { setServiceStatus, ServiceStatusConflictError } = await import('./repository.js');
    const cancelled = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, ENGINE_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof TransactWriteCommand) {
        return Promise.reject(cancelled);
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await expect(
      setServiceStatus(client, TABLE, {
        deptId: DEPT_ID,
        unitId: 'E1',
        status: 'OUT_OF_SERVICE',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ServiceStatusConflictError);

    const logged = errorSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('apparatus.setServiceStatus.failed'));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged ?? '{}') as {
      cancellationReasons?: string[];
      errorMessage?: string;
    };
    expect(parsed.cancellationReasons).toEqual(['ConditionalCheckFailed', 'None']);
    expect(parsed.errorMessage).toBe('Transaction cancelled');
    errorSpy.mockRestore();
  });

  it('maps a non-conditional DynamoDB TransactWriteItems failure to ApparatusRepositoryUnavailableError (dependency unavailable)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { setServiceStatus, ApparatusRepositoryUnavailableError } =
      await import('./repository.js');
    const send = vi.fn((command: unknown) => {
      const lookup = registryLookup(command, ENGINE_METADATA);
      if (lookup) return Promise.resolve(lookup);
      if (command instanceof TransactWriteCommand) {
        return Promise.reject(new Error('DynamoDB unavailable'));
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as DynamoDBDocumentClient;

    await expect(
      setServiceStatus(client, TABLE, {
        deptId: DEPT_ID,
        unitId: 'E1',
        status: 'OUT_OF_SERVICE',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ApparatusRepositoryUnavailableError);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('listApparatus', () => {
  it('attaches reason and elapsedSeconds only to out-of-service apparatus, from the denormalized GSI3 item, without a per-item query (AC3, no N+1)', async () => {
    const { listApparatus } = await import('./repository.js');
    const startAt = Math.floor(Date.now() / 1000) - 5;
    const client = fakeClient((command) => {
      if (command instanceof QueryCommand && command.input.IndexName === 'GSI3') {
        return {
          Items: [
            { unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' },
            {
              unitId: 'L1',
              type: 'LADDER',
              status: 'OUT_OF_SERVICE',
              outOfServiceReason: 'Pump failure',
              outOfServiceStartAt: startAt,
            },
          ],
        };
      }
      throw new Error('unexpected command: N+1 per-item query should not happen');
    });

    const result = await listApparatus(client, TABLE, DEPT_ID);

    expect((client.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(result).toHaveLength(2);
    const engine = result.find((item) => item.unitId === 'E1');
    const ladder = result.find((item) => item.unitId === 'L1');
    expect(engine?.outOfService).toBeUndefined();
    expect(ladder?.outOfService?.reason).toBe('Pump failure');
    expect(ladder?.outOfService?.elapsedSeconds).toBeGreaterThanOrEqual(5);
  });

  it('filters the registry by status app-side', async () => {
    const { listApparatus } = await import('./repository.js');
    const client = fakeClient((command) => {
      if (command instanceof QueryCommand) {
        return {
          Items: [
            { unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' },
            { unitId: 'L1', type: 'LADDER', status: 'OUT_OF_SERVICE' },
          ],
        };
      }
      throw new Error('unexpected command');
    });

    const result = await listApparatus(client, TABLE, DEPT_ID, 'IN_SERVICE');
    expect(result).toEqual([{ unitId: 'E1', type: 'ENGINE', status: 'IN_SERVICE' }]);
  });

  it('logs the original error (including error.message) and wraps a registry query failure as ApparatusRepositoryUnavailableError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { listApparatus, ApparatusRepositoryUnavailableError } = await import('./repository.js');
    const client = fakeClient(() => {
      throw new Error('table unavailable');
    });

    await expect(listApparatus(client, TABLE, DEPT_ID)).rejects.toBeInstanceOf(
      ApparatusRepositoryUnavailableError,
    );
    const logged = errorSpy.mock.calls
      .map((call) => call[0] as string)
      .find((line) => line.includes('apparatus.listApparatus.failed'));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged ?? '{}') as { errorMessage?: string };
    expect(parsed.errorMessage).toBe('table unavailable');
    errorSpy.mockRestore();
  });
});
