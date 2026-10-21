import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createConsumable,
  listConsumables,
  queryConsumablesBelowThreshold,
  restockConsumable,
} from './consumableRepository.js';

const TABLE = 'boxalarm-platform';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDocClient(handler: (command: unknown) => unknown): {
  client: DynamoDBDocumentClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn((command: unknown) => Promise.resolve(handler(command)));
  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    send,
  };
}

// Shaped exactly as Data Model §3.3 defines CONSUMABLE_STOCK: pk, sk, entityType,
// stockLevel, reorderThreshold, location — no denormalized itemId/deptId/itemName.
function consumableItem(
  itemId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pk: `DEPT#NICHOLS#CONSUMABLE#${itemId}`,
    sk: 'METADATA',
    entityType: 'CONSUMABLE_STOCK',
    itemName: `Item ${itemId}`,
    stockLevel: 12,
    reorderThreshold: 5,
    location: 'Station 1',
    ...overrides,
  };
}

function fakeGsi3QueryWithFilter(items: readonly Record<string, unknown>[]) {
  return (command: unknown) => {
    const query = command as QueryCommand;
    const filtered = query.input.FilterExpression
      ? items.filter((item) => (item.stockLevel as number) <= (item.reorderThreshold as number))
      : items;
    return { Items: filtered };
  };
}

describe('listConsumables', () => {
  it('AC1: queries GSI3 by department, derives itemId/deptId from pk, and flags at/below-threshold items distinctly', async () => {
    const { client } = fakeDocClient((command) => {
      const query = command as QueryCommand;
      expect(query).toBeInstanceOf(QueryCommand);
      expect(query.input.IndexName).toBe('GSI3');
      expect(query.input.ExpressionAttributeValues?.[':gsi3Pk']).toBe('DEPT#NICHOLS#CONSUMABLE');
      return {
        Items: [
          consumableItem('GLOVES-L', { stockLevel: 5, reorderThreshold: 5 }),
          consumableItem('STRAPS-M', { stockLevel: 20, reorderThreshold: 5 }),
        ],
      };
    });

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(2);
    const gloves = items.find((item) => item.itemId === 'GLOVES-L');
    expect(gloves?.deptId).toBe('NICHOLS');
    expect(gloves?.reorderFlagged).toBe(true);
    expect(items.find((item) => item.itemId === 'STRAPS-M')?.reorderFlagged).toBe(false);
  });

  it('tolerates a missing stockLevel/reorderThreshold without crashing and never flags it (defensive)', async () => {
    const { client } = fakeDocClient(() => ({
      Items: [consumableItem('GLOVES-L', { stockLevel: undefined, reorderThreshold: undefined })],
    }));

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.reorderFlagged).toBe(false);
  });

  it('returns an empty list for a department with zero consumable items', async () => {
    const { client } = fakeDocClient(() => ({ Items: [] }));

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toEqual([]);
  });

  it('skips (and never crashes on) an item with an unparseable pk or missing itemName, logging and metering it as malformed', async () => {
    const { client } = fakeDocClient(() => ({
      Items: [
        { pk: 'DEPT#NICHOLS#CONSUMABLE#GLOVES-L', sk: 'METADATA', entityType: 'CONSUMABLE_STOCK' },
        { pk: 'not-a-valid-pk', sk: 'METADATA', entityType: 'CONSUMABLE_STOCK', itemName: 'X' },
        consumableItem('STRAPS-M'),
      ],
    }));

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe('STRAPS-M');
  });
});

describe('queryConsumablesBelowThreshold', () => {
  it('AC2: applies a stockLevel <= reorderThreshold filter server-side, in-partition by department', async () => {
    const { client } = fakeDocClient((command) => {
      const query = command as QueryCommand;
      expect(query.input.FilterExpression).toBe('stockLevel <= reorderThreshold');
      expect(query.input.ExpressionAttributeValues?.[':gsi3Pk']).toBe('DEPT#NICHOLS#CONSUMABLE');
      return { Items: [consumableItem('GLOVES-L', { stockLevel: 3, reorderThreshold: 5 })] };
    });

    const items = await queryConsumablesBelowThreshold(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe('GLOVES-L');
    expect(items[0]?.reorderFlagged).toBe(true);
  });

  it('AC3: a restocked item above threshold is excluded from the below-threshold query results (fake applies the real FilterExpression against both items)', async () => {
    const belowThreshold = consumableItem('GLOVES-L', { stockLevel: 3, reorderThreshold: 5 });
    const aboveThreshold = consumableItem('STRAPS-M', { stockLevel: 20, reorderThreshold: 5 });
    const { client } = fakeDocClient(fakeGsi3QueryWithFilter([belowThreshold, aboveThreshold]));

    const items = await queryConsumablesBelowThreshold(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe('GLOVES-L');
    expect(items.some((item) => item.itemId === 'STRAPS-M')).toBe(false);
  });
});

describe('restockConsumable', () => {
  it('AC1: last-writer-wins UpdateItem on stockLevel, returning the updated consumable', async () => {
    const { client } = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        expect(command.input.Key).toEqual({
          pk: 'DEPT#NICHOLS#CONSUMABLE#GLOVES-L',
          sk: 'METADATA',
        });
        expect(command.input.ConditionExpression).toBe('attribute_exists(pk)');
        expect(command.input.ExpressionAttributeValues).toEqual({ ':stockLevel': 40 });
        return { Attributes: consumableItem('GLOVES-L', { stockLevel: 40 }) };
      }
      return {};
    });

    const consumable = await restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'GLOVES-L', {
      stockLevel: 40,
    });

    expect(consumable?.stockLevel).toBe(40);
  });

  it('AC2: updates both stockLevel and reorderThreshold in a single UpdateItem', async () => {
    const { client } = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        expect(command.input.ExpressionAttributeValues).toEqual({
          ':stockLevel': 40,
          ':reorderThreshold': 8,
        });
        return {
          Attributes: consumableItem('GLOVES-L', { stockLevel: 40, reorderThreshold: 8 }),
        };
      }
      return {};
    });

    const consumable = await restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'GLOVES-L', {
      stockLevel: 40,
      reorderThreshold: 8,
    });

    expect(consumable?.stockLevel).toBe(40);
    expect(consumable?.reorderThreshold).toBe(8);
  });

  it('AC3: writes an undeletable-style AUDIT_LOG_ENTRY (attribute_not_exists guard) after a successful restock', async () => {
    const { client, send } = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        return { Attributes: consumableItem('GLOVES-L', { stockLevel: 40 }) };
      }
      if (command instanceof PutCommand) {
        expect(command.input.ConditionExpression).toBe(
          'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        );
        expect(command.input.Item?.entityType).toBe('AUDIT_LOG_ENTRY');
        expect(command.input.Item?.mutatedEntityType).toBe('CONSUMABLE_STOCK');
        expect(command.input.Item?.mutatedEntityId).toBe('GLOVES-L');
        expect(command.input.Item?.actorId).toBe('chief-1');
        return {};
      }
      return {};
    });

    await restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'GLOVES-L', { stockLevel: 40 });

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('records the prior stockLevel as old and returns the new value (audit before/after)', async () => {
    let auditFields: unknown;
    const { client } = fakeDocClient((command) => {
      if (command instanceof UpdateCommand) {
        expect(command.input.ReturnValues).toBe('ALL_OLD');
        return { Attributes: consumableItem('GLOVES-L', { stockLevel: 12, reorderThreshold: 5 }) };
      }
      if (command instanceof PutCommand) {
        auditFields = command.input.Item?.changedFields;
      }
      return {};
    });

    const consumable = await restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'GLOVES-L', {
      stockLevel: 3,
    });

    expect(auditFields).toEqual({ stockLevel: { old: 12, new: 3 } });
    expect(consumable?.stockLevel).toBe(3);
    expect(consumable?.reorderFlagged).toBe(true);
  });

  it('returns undefined (no audit write) when the item does not exist', async () => {
    const { client, send } = fakeDocClient(() => {
      throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
    });

    const consumable = await restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'missing', {
      stockLevel: 40,
    });

    expect(consumable).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows an unrelated DynamoDB failure instead of swallowing it', async () => {
    const { client } = fakeDocClient(() => {
      throw new Error('boom');
    });

    await expect(
      restockConsumable(client, TABLE, DEPT_ID, 'chief-1', 'GLOVES-L', { stockLevel: 40 }),
    ).rejects.toThrow('boom');
  });
});

describe('createConsumable', () => {
  const input = {
    itemName: 'Nitrile gloves',
    stockLevel: 40,
    reorderThreshold: 10,
    location: 'Station 1',
  };

  it('writes a GSI3-indexed CONSUMABLE_STOCK with itemName and a CREATE audit entry, so the new item is listable', async () => {
    const puts: PutCommand['input'][] = [];
    const { client } = fakeDocClient((command) => {
      if (command instanceof TransactWriteCommand) {
        for (const transactItem of command.input.TransactItems ?? []) {
          if (transactItem.Put) {
            puts.push(transactItem.Put);
          }
        }
        return {};
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const created = await createConsumable(client, TABLE, DEPT_ID, 'MBR-1', input);

    const item = puts[0]?.Item;
    expect(item).toMatchObject({
      entityType: 'CONSUMABLE_STOCK',
      sk: 'METADATA',
      itemName: 'Nitrile gloves',
      stockLevel: 40,
      reorderThreshold: 10,
      location: 'Station 1',
      gsi3pk: 'DEPT#NICHOLS#CONSUMABLE',
    });
    expect(item?.pk).toBe(`DEPT#NICHOLS#CONSUMABLE#${created.itemId}`);
    expect(item?.gsi3sk).toBe(created.itemId);
    expect(puts[0]?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(puts[1]?.Item).toMatchObject({
      mutatedEntityType: 'CONSUMABLE_STOCK',
      mutatedEntityId: created.itemId,
      action: 'CREATE',
      actorId: 'MBR-1',
    });
    expect(created).toMatchObject({
      itemName: 'Nitrile gloves',
      deptId: 'NICHOLS',
      reorderFlagged: false,
    });
  });

  it('round-trips through the list read path', async () => {
    let stored: Record<string, unknown> | undefined;
    const { client } = fakeDocClient((command) => {
      if (command instanceof TransactWriteCommand) {
        stored ??= command.input.TransactItems?.[0]?.Put?.Item;
        return {};
      }
      return { Items: [stored] };
    });

    const created = await createConsumable(client, TABLE, DEPT_ID, 'MBR-1', input);
    const listed = await listConsumables(client, TABLE, DEPT_ID);

    expect(listed).toEqual([created]);
  });
});
