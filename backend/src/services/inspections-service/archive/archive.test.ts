import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ArchiveTargetNotFoundError,
  archiveHydrant,
  archiveOccupancy,
} from './archiveRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

interface Command {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

type TransactItem = {
  Update?: { Key: Record<string, string>; UpdateExpression: string; ConditionExpression: string };
  Put?: { Item: Record<string, unknown>; ConditionExpression?: string };
};

function fakeDoc(metadata: Record<string, unknown> | undefined, transact?: () => Promise<unknown>) {
  const transactions: TransactItem[][] = [];
  const send = vi.fn((command: Command) => {
    if (command.constructor.name === 'GetCommand') return Promise.resolve({ Item: metadata });
    transactions.push(command.input.TransactItems as TransactItem[]);
    return transact ? transact() : Promise.resolve({});
  });
  return { transactions, send, client: { send } as unknown as DynamoDBDocumentClient };
}

describe('archiveOccupancy', () => {
  const OCCUPANCY = { occupancyId: 'OCC-1', normalizedAddress: '12 MAIN ST' };

  it('in one transaction: marks it archived and off the map, drops its list and address index rows, audits, and emits an archive event', async () => {
    const { transactions, client } = fakeDoc(OCCUPANCY);

    const result = await archiveOccupancy(client, 'platform', DEPT_ID, 'OCC-1', 'chief-1');

    expect(result.changed).toBe(true);
    const [items] = transactions as [TransactItem[]];
    expect(items[0]?.Update).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1', sk: 'METADATA' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(archivedAt)',
    });
    expect(items[0]?.Update?.UpdateExpression).toContain('REMOVE gsi3pk, gsi3sk');
    // Index rows leave their GSI3 partitions (no DeleteItem anywhere in inspections).
    const offIndex = items.slice(1).filter((i) => i.Update);
    expect(offIndex.map((i) => [i.Update?.Key.sk, i.Update?.UpdateExpression])).toEqual([
      ['LIST', 'REMOVE gsi3pk, gsi3sk'],
      ['ADDR#12 MAIN ST', 'REMOVE gsi3pk, gsi3sk'],
    ]);
    const puts = items.filter((i) => i.Put).map((i) => i.Put?.Item);
    expect(puts[0]).toMatchObject({ entityType: 'AUDIT_LOG_ENTRY', action: 'ARCHIVE' });
    expect(puts[1]).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'inspections.preplan.updated',
      payload: { deptId: 'NICHOLS', occupancyId: 'OCC-1', archived: true },
    });
  });

  it('is idempotent: an already archived occupancy writes nothing', async () => {
    const { transactions, client } = fakeDoc({ ...OCCUPANCY, archivedAt: 42 });
    expect(await archiveOccupancy(client, 'platform', DEPT_ID, 'OCC-1', 'chief-1')).toEqual({
      archivedAt: 42,
      changed: false,
    });
    expect(transactions).toEqual([]);
  });

  it('throws ArchiveTargetNotFoundError for an unknown occupancy', async () => {
    const { client } = fakeDoc(undefined);
    await expect(
      archiveOccupancy(client, 'platform', DEPT_ID, 'OCC-X', 'chief-1'),
    ).rejects.toBeInstanceOf(ArchiveTargetNotFoundError);
  });

  it('reports the concurrent archive when it loses a race', async () => {
    let reads = 0;
    const send = vi.fn((command: Command) => {
      if (command.constructor.name === 'GetCommand') {
        reads += 1;
        return Promise.resolve({ Item: reads === 1 ? OCCUPANCY : { ...OCCUPANCY, archivedAt: 7 } });
      }
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
    });
    const client = { send } as unknown as DynamoDBDocumentClient;
    expect(await archiveOccupancy(client, 'platform', DEPT_ID, 'OCC-1', 'chief-1')).toEqual({
      archivedAt: 7,
      changed: false,
    });
  });
});

describe('archiveHydrant', () => {
  it('takes it off the map, the due list and the department list, and emits an archive event', async () => {
    const { transactions, client } = fakeDoc({ hydrantId: 'HYD-1', updatedAt: 1 });

    await archiveHydrant(client, 'platform', DEPT_ID, 'HYD-1', 'chief-1');

    const [items] = transactions as [TransactItem[]];
    expect(items[0]?.Update?.UpdateExpression).toContain('REMOVE gsi2pk, gsi2sk, gsi3pk, gsi3sk');
    expect(items[1]?.Update).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-1', sk: 'LIST' },
      UpdateExpression: 'REMOVE gsi3pk, gsi3sk',
    });
    expect(items.at(-1)?.Put?.Item).toMatchObject({
      eventType: 'inspections.hydrant.updated',
      payload: { hydrantId: 'HYD-1', deptId: 'NICHOLS', archived: true },
    });
  });
});

describe('archive handlers (Cedar ArchiveOccupancy / ArchiveHydrant)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform';
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function event(pathParameters: Record<string, string>): GuardEvent {
    return {
      version: '2.0',
      routeKey: 'POST /api/v1/inspections/occupancies/{id}/archive',
      rawPath: '/api/v1/inspections/occupancies/OCC-1/archive',
      rawQueryString: '',
      headers: { authorization: 'Bearer token-1' },
      pathParameters,
      requestContext: {
        authorizer: { lambda: { sub: 'chief-1', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' } },
      },
    } as unknown as GuardEvent;
  }

  function authz(decision: 'ALLOW' | 'DENY') {
    const send = vi.fn().mockResolvedValue({ decision: Decision[decision] });
    return { send, client: { send } as unknown as VerifiedPermissionsClient };
  }

  it('asks Cedar for ArchiveOccupancy on the occupancy, then archives (200)', async () => {
    const { createArchiveHandler } = await import('./archiveHandler.js');
    const { client, transactions } = fakeDoc({ occupancyId: 'OCC-1' });
    const vp = authz('ALLOW');
    const handler = createArchiveHandler('occupancy', {
      docClient: client,
      authzClient: vp.client,
    });

    const result = await handler(event({ id: 'OCC-1' }));

    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({
      occupancyId: 'OCC-1',
      archived: true,
      changed: true,
    });
    const input = (vp.send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.action).toEqual({ actionType: 'Boxalarm::Action', actionId: 'ArchiveOccupancy' });
    expect(input.resource).toEqual({ entityType: 'Boxalarm::Occupancy', entityId: 'OCC-1' });
    expect(transactions).toHaveLength(1);
  });

  it('is 403 and writes nothing on a Cedar deny (officers cannot archive)', async () => {
    const { createArchiveHandler } = await import('./archiveHandler.js');
    const { client, send } = fakeDoc({ hydrantId: 'HYD-1' });
    const handler = createArchiveHandler('hydrant', {
      docClient: client,
      authzClient: authz('DENY').client,
    });

    const result = await handler(event({ hydrantId: 'HYD-1' }));

    expect(result).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown hydrant', async () => {
    const { createArchiveHandler } = await import('./archiveHandler.js');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = fakeDoc(undefined);
    const handler = createArchiveHandler('hydrant', {
      docClient: client,
      authzClient: authz('ALLOW').client,
    });

    expect(await handler(event({ hydrantId: 'HYD-X' }))).toMatchObject({ statusCode: 404 });
  });
});
