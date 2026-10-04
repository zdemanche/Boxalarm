import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

function consumableKey(deptId: VerifiedDeptId, itemId: string) {
  return { pk: buildDeptScopedPk(deptId, 'CONSUMABLE', itemId), sk: 'METADATA' as const };
}

type AuditChangedFields = Record<string, { readonly old?: unknown; readonly new: unknown }>;

async function writeAuditLogEntry(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  itemId: string,
  changedFields: AuditChangedFields,
): Promise<void> {
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'AUDIT', date),
        sk: `${ts}#CONSUMABLE_STOCK#${itemId}#${actorId}`,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'CONSUMABLE_STOCK',
        mutatedEntityId: itemId,
        action: 'UPDATE' as const,
        actorId,
        changedFields,
        ts,
        gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'CONSUMABLE_STOCK', itemId),
        gsi3sk: String(ts),
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }),
  );
}

export interface RestockConsumableInput {
  readonly stockLevel?: number;
  readonly reorderThreshold?: number;
}

/**
 * #131 / N-9 (decided): `PUT /api/v1/inventory/consumables/{itemId}` sets `stockLevel` and/or
 * `reorderThreshold` on `CONSUMABLE_STOCK` directly — last-writer-wins, like every other
 * current-state PUT in this table (architecture.md:498); no adjustment-history entity exists.
 */
export async function restockConsumable(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  itemId: string,
  input: RestockConsumableInput,
): Promise<ConsumableStock | undefined> {
  const expressionValues: Record<string, number> = {};
  const setClauses: string[] = [];
  const changedFields: AuditChangedFields = {};
  if (input.stockLevel !== undefined) {
    setClauses.push('stockLevel = :stockLevel');
    expressionValues[':stockLevel'] = input.stockLevel;
    changedFields.stockLevel = { new: input.stockLevel };
  }
  if (input.reorderThreshold !== undefined) {
    setClauses.push('reorderThreshold = :reorderThreshold');
    expressionValues[':reorderThreshold'] = input.reorderThreshold;
    changedFields.reorderThreshold = { new: input.reorderThreshold };
  }

  let attributes: Record<string, unknown> | undefined;
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: consumableKey(deptId, itemId),
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: `SET ${setClauses.join(', ')}`,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
      }),
    );
    attributes = result.Attributes;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return undefined;
    }
    throw error;
  }
  if (!attributes) {
    return undefined;
  }

  await writeAuditLogEntry(docClient, tableName, deptId, actorId, itemId, changedFields);
  return toConsumableStock(attributes as unknown as ConsumableStockItem);
}
