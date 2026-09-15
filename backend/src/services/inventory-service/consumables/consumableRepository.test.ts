import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { listConsumables, queryConsumablesBelowThreshold } from './consumableRepository.js';

const TABLE = 'boxalarm-platform';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDocClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return {
    send: vi.fn((command: unknown) => Promise.resolve(send(command))),
  } as unknown as DynamoDBDocumentClient;
}

function consumableItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityType: 'CONSUMABLE_STOCK',
    itemId: 'GLOVES-L',
    deptId: 'NICHOLS',
    itemName: 'Gloves (Large)',
    stockLevel: 12,
    reorderThreshold: 5,
    location: 'Station 1',
    ...overrides,
  };
}

describe('listConsumables', () => {
  it('AC1: queries GSI3 by department and flags at/below-threshold items distinctly from adequate stock', async () => {
    const client = fakeDocClient((command) => {
      const query = command as QueryCommand;
      expect(query).toBeInstanceOf(QueryCommand);
      expect(query.input.IndexName).toBe('GSI3');
      expect(query.input.ExpressionAttributeValues?.[':gsi3Pk']).toBe(
        'DEPT#NICHOLS#CONSUMABLE',
      );
      return {
        Items: [
          consumableItem({ itemId: 'GLOVES-L', stockLevel: 5, reorderThreshold: 5 }),
          consumableItem({ itemId: 'STRAPS-M', stockLevel: 20, reorderThreshold: 5 }),
        ],
      };
    });

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(2);
    expect(items.find((item) => item.itemId === 'GLOVES-L')?.reorderFlagged).toBe(true);
    expect(items.find((item) => item.itemId === 'STRAPS-M')?.reorderFlagged).toBe(false);
  });

  it('tolerates a missing stockLevel/reorderThreshold without crashing and never flags it (defensive)', async () => {
    const client = fakeDocClient(() => ({
      Items: [consumableItem({ stockLevel: undefined, reorderThreshold: undefined })],
    }));

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.reorderFlagged).toBe(false);
  });

  it('returns an empty list for a department with zero consumable items', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));

    const items = await listConsumables(client, TABLE, DEPT_ID);

    expect(items).toEqual([]);
  });
});

describe('queryConsumablesBelowThreshold', () => {
  it('AC2: applies a stockLevel <= reorderThreshold filter server-side, in-partition by department', async () => {
    const client = fakeDocClient((command) => {
      const query = command as QueryCommand;
      expect(query.input.FilterExpression).toBe('stockLevel <= reorderThreshold');
      expect(query.input.ExpressionAttributeValues?.[':gsi3Pk']).toBe(
        'DEPT#NICHOLS#CONSUMABLE',
      );
      return { Items: [consumableItem({ itemId: 'GLOVES-L', stockLevel: 3, reorderThreshold: 5 })] };
    });

    const items = await queryConsumablesBelowThreshold(client, TABLE, DEPT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe('GLOVES-L');
    expect(items[0]?.reorderFlagged).toBe(true);
  });

  it('AC3: a restocked item above threshold is excluded from the below-threshold query results (DynamoDB applies the FilterExpression server-side)', async () => {
    const client = fakeDocClient(() => ({ Items: [] }));

    const items = await queryConsumablesBelowThreshold(client, TABLE, DEPT_ID);

    expect(items).toEqual([]);
  });
});
