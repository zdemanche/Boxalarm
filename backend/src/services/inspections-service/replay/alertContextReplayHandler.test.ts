import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

interface Command {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

const OCCUPANCIES: Record<string, Record<string, unknown>> = {
  'OCC-1': {
    occupancyId: 'OCC-1',
    address: '123 Main Street',
    normalizedAddress: '123 MAIN STREET',
    occupancyType: 'MULTI_FAMILY',
    latitude: 41.2429,
    longitude: -73.2007,
  },
  'OCC-2': { occupancyId: 'OCC-2', address: '9 Elm St', occupancyType: 'COMMERCIAL' },
};
const PLANS: Record<string, Record<string, unknown>> = {
  'OCC-1': {
    pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1',
    sk: 'PREPLAN#PP-1',
    prePlanId: 'PP-1',
    hazards: ['LPG_TANK_REAR'],
    utilityShutoffs: [{ utility: 'GAS', location: 'rear' }],
    updatedAt: 1000,
  },
};
const HYDRANTS: Record<string, Record<string, unknown>> = {
  'HYD-1': {
    hydrantId: 'HYD-1',
    latitude: 41.2417,
    longitude: -73.2004,
    status: 'OUT_OF_SERVICE',
    size: '6-inch',
    flowRatingGpm: 1000,
    updatedAt: 2000,
  },
  'HYD-2': { hydrantId: 'HYD-2', latitude: 41.25, longitude: -73.21, updatedAt: 3000 },
};

function fakeTable(options: { failConditionFor?: string } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const send = vi.fn((command: Command) => {
    const { input } = command;
    switch (command.constructor.name) {
      case 'QueryCommand': {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        if (values[':gsi3pk'] === 'DEPT#NICHOLS#OCCUPANCY') {
          return Promise.resolve({
            Items: Object.keys(OCCUPANCIES).map((occupancyId) => ({ occupancyId })),
          });
        }
        if (values[':gsi3pk'] === 'DEPT#NICHOLS#HYDRANT') {
          return Promise.resolve({
            Items: Object.keys(HYDRANTS).map((hydrantId) => ({ hydrantId })),
          });
        }
        const occupancyId = values[':pk']?.split('#').pop() ?? '';
        return Promise.resolve({ Items: PLANS[occupancyId] ? [PLANS[occupancyId]] : [] });
      }
      case 'GetCommand': {
        const key = input.Key as { pk: string };
        const id = key.pk.split('#').pop() ?? '';
        return Promise.resolve({
          Item: key.pk.includes('#HYDRANT#') ? HYDRANTS[id] : OCCUPANCIES[id],
        });
      }
      case 'TransactWriteCommand': {
        const items = input.TransactItems as Array<{
          ConditionCheck?: { Key: { pk: string } };
          Put?: { Item: Record<string, unknown> };
        }>;
        if (
          options.failConditionFor &&
          items[0]?.ConditionCheck?.Key.pk.endsWith(options.failConditionFor)
        ) {
          return Promise.reject(
            new TransactionCanceledException({
              message: 'cancelled',
              $metadata: {},
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            }),
          );
        }
        writes.push({
          conditionCheck: items[0]?.ConditionCheck,
          outbox: items[1]?.Put?.Item,
        });
        return Promise.resolve({});
      }
      default:
        return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    }
  });
  return { writes, send, client: { send } as unknown as DynamoDBDocumentClient };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('alert-context replay (post-deploy backfill / normalizer replay)', () => {
  it('re-emits one inspections.preplan.updated per pre-planned occupancy and one inspections.hydrant.updated per hydrant, with the full alert payload', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { writes, client } = fakeTable();

    const result = await createAlertContextReplayHandler(client)({ deptId: 'NICHOLS' });

    expect(result).toEqual({
      deptId: 'NICHOLS',
      dryRun: false,
      prePlans: { emitted: 1, skippedConcurrentEdit: 0, skippedNoPrePlan: 1 },
      hydrants: { emitted: 2, skippedConcurrentEdit: 0 },
    });
    const events = writes.map((write) => write.outbox as Record<string, unknown>);
    expect(events.map((event) => event.eventType)).toEqual([
      'inspections.preplan.updated',
      'inspections.hydrant.updated',
      'inspections.hydrant.updated',
    ]);
    expect(events[0]).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      pk: 'DEPT#NICHOLS#OUTBOX',
      source: 'inspections-service',
      payload: {
        deptId: 'NICHOLS',
        occupancyId: 'OCC-1',
        prePlanId: 'PP-1',
        summary: 'Multi family — 123 Main Street',
        address: '123 Main Street',
        latitude: 41.2429,
        longitude: -73.2007,
        hazards: ['LPG_TANK_REAR'],
      },
    });
    expect(events[1]).toMatchObject({
      payload: { hydrantId: 'HYD-1', status: 'OUT_OF_SERVICE', flowRatingGpm: 1000 },
    });
  });

  it('conditions every outbox write on the source item being unchanged since it was read', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { writes, client } = fakeTable();

    await createAlertContextReplayHandler(client)({ deptId: 'NICHOLS' });

    expect(writes.map((write) => write.conditionCheck)).toEqual([
      expect.objectContaining({
        Key: { pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1', sk: 'PREPLAN#PP-1' },
        ConditionExpression: 'updatedAt = :readUpdatedAt',
        ExpressionAttributeValues: { ':readUpdatedAt': 1000 },
      }),
      expect.objectContaining({
        Key: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-1', sk: 'METADATA' },
        ExpressionAttributeValues: { ':readUpdatedAt': 2000 },
      }),
      expect.objectContaining({ Key: { pk: 'DEPT#NICHOLS#HYDRANT#HYD-2', sk: 'METADATA' } }),
    ]);
  });

  it('skips (and counts) an item edited between its read and the replay write — the edit emitted its own newer event', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { writes, client } = fakeTable({ failConditionFor: 'HYD-1' });

    const result = await createAlertContextReplayHandler(client)({ deptId: 'NICHOLS' });

    expect(result.hydrants).toEqual({ emitted: 1, skippedConcurrentEdit: 1 });
    expect(writes).toHaveLength(2);
  });

  it('writes nothing on a dry run but reports what it would emit', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { writes, client } = fakeTable();

    const result = await createAlertContextReplayHandler(client)({
      deptId: 'NICHOLS',
      dryRun: true,
    });

    expect(result.prePlans.emitted).toBe(1);
    expect(result.hydrants.emitted).toBe(2);
    expect(writes).toEqual([]);
  });

  it('is repeatable: a second run emits the same set again (consumers upsert to the same copies)', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { writes, client } = fakeTable();
    const replay = createAlertContextReplayHandler(client);

    await replay({ deptId: 'NICHOLS' });
    await replay({ deptId: 'NICHOLS' });

    const payloads = writes.map((write) => (write.outbox as { payload: unknown }).payload);
    expect(payloads.slice(3)).toEqual(payloads.slice(0, 3));
  });

  it('rejects a missing or delimiter-bearing deptId before reading anything', async () => {
    const { createAlertContextReplayHandler } = await import('./alertContextReplayHandler.js');
    const { send, client } = fakeTable();
    const replay = createAlertContextReplayHandler(client);

    await expect(replay({ deptId: '' })).rejects.toThrow(/deptId/);
    await expect(replay({ deptId: 'A#B' })).rejects.toThrow(/deptId/);
    expect(send).not.toHaveBeenCalled();
  });
});
