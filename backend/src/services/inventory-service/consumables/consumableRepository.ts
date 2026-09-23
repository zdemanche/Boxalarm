import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitMetric, logEvent } from '../lib/logger.js';

export interface ConsumableStock {
  readonly itemId: string;
  readonly deptId: string;
  readonly itemName: string;
  readonly stockLevel: number;
  readonly reorderThreshold: number;
  readonly location?: string;
  readonly reorderFlagged: boolean;
}

interface ConsumableStockItem {
  readonly pk?: unknown;
  readonly entityType: 'CONSUMABLE_STOCK';
  readonly itemName?: string;
  readonly stockLevel?: number;
  readonly reorderThreshold?: number;
  readonly location?: string;
}

const PK_PATTERN = /^DEPT#(.+)#CONSUMABLE#(.+)$/;

function parsePk(rawPk: unknown): { deptId: string; itemId: string } | undefined {
  if (typeof rawPk !== 'string') {
    return undefined;
  }
  const match = PK_PATTERN.exec(rawPk);
  if (!match) {
    return undefined;
  }
  const [, deptId, itemId] = match;
  return deptId && itemId ? { deptId, itemId } : undefined;
}

function toConsumableStock(item: ConsumableStockItem): ConsumableStock | undefined {
  const identity = parsePk(item.pk);
  if (!identity || !item.itemName) {
    const itemPk = item.pk;
    const rawPk = typeof itemPk === 'string' ? itemPk : undefined;
    logEvent('error', {
      correlationId: 'N/A',
      event: 'inventory.consumables.malformedItem',
      message: 'CONSUMABLE_STOCK item is missing a parseable pk or itemName; skipping',
      rawPk,
    });
    emitMetric('MalformedItem');
    return undefined;
  }
  return {
    itemId: identity.itemId,
    deptId: identity.deptId,
    itemName: item.itemName,
    stockLevel: item.stockLevel ?? 0,
    reorderThreshold: item.reorderThreshold ?? 0,
    ...(item.location ? { location: item.location } : {}),
    reorderFlagged:
      item.stockLevel !== undefined &&
      item.reorderThreshold !== undefined &&
      item.stockLevel <= item.reorderThreshold,
  };
}

async function queryAllPages(
  docClient: DynamoDBDocumentClient,
  params: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        ...params,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items as Record<string, unknown>[] | undefined) ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

function toConsumableStockList(items: readonly Record<string, unknown>[]): ConsumableStock[] {
  const stocks: ConsumableStock[] = [];
  for (const item of items) {
    const stock = toConsumableStock(item as unknown as ConsumableStockItem);
    if (stock) {
      stocks.push(stock);
    }
  }
  return stocks;
}

export async function listConsumables(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly ConsumableStock[]> {
  const items = await queryAllPages(docClient, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :gsi3Pk',
    ExpressionAttributeValues: { ':gsi3Pk': buildDeptScopedPk(deptId, 'CONSUMABLE') },
  });
  return toConsumableStockList(items);
}

export async function queryConsumablesBelowThreshold(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly ConsumableStock[]> {
  const items = await queryAllPages(docClient, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :gsi3Pk',
    FilterExpression: 'stockLevel <= reorderThreshold',
    ExpressionAttributeValues: { ':gsi3Pk': buildDeptScopedPk(deptId, 'CONSUMABLE') },
  });
  return toConsumableStockList(items);
}
