import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

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
  readonly entityType: 'CONSUMABLE_STOCK';
  readonly itemId: string;
  readonly deptId: string;
  readonly itemName: string;
  readonly stockLevel?: number;
  readonly reorderThreshold?: number;
  readonly location?: string;
}

function toConsumableStock(item: ConsumableStockItem): ConsumableStock {
  return {
    itemId: item.itemId,
    deptId: item.deptId,
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
  return items.map((item) => toConsumableStock(item as unknown as ConsumableStockItem));
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
  return items.map((item) => toConsumableStock(item as unknown as ConsumableStockItem));
}
