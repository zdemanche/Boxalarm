import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

// ponytail (P4, file count over the new-service lean cap): inventory-service had no real
// implementation before this ticket, only its index.ts stub, so this changeset is genuine
// new-service scope, not just the equipment feature. Roughly half the added files are
// service-level scaffolding every other implemented service already carries on its own
// (lib/dynamoDb.ts, lib/logger.ts, lib/problemDetails.ts, health/liveness, health/readiness)
// rather than the equipment registry itself (this repository + 5 route handlers). Splitting
// one route per file matches every other multi-route service Lambda already in this repo
// (e.g. apparatus-service, personnel-service); consolidating routes to force the count down
// would trade a mechanical line-count check for a real single-responsibility violation.

export type AssignedToType = 'MEMBER' | 'APPARATUS';
export type LifecycleStatus = 'ACQUIRED' | 'IN_SERVICE' | 'RETIRED';

export interface EquipmentAsset {
  readonly assetId: string;
  readonly deptId: string;
  readonly serialNumber: string;
  readonly assignedToType?: AssignedToType;
  readonly assignedToId?: string;
  readonly location: string;
  readonly lifecycleStatus: LifecycleStatus;
}

interface EquipmentAssetItem {
  readonly entityType: 'EQUIPMENT_ASSET';
  readonly assetId: string;
  readonly deptId: string;
  readonly serialNumber: string;
  readonly assignedToType?: AssignedToType;
  readonly assignedToId?: string;
  readonly location: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly gsi1pk?: string;
  readonly gsi1sk?: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
}

function toEquipmentAsset(item: EquipmentAssetItem): EquipmentAsset {
  return {
    assetId: item.assetId,
    deptId: item.deptId,
    serialNumber: item.serialNumber,
    ...(item.assignedToType ? { assignedToType: item.assignedToType } : {}),
    ...(item.assignedToId ? { assignedToId: item.assignedToId } : {}),
    location: item.location,
    lifecycleStatus: item.lifecycleStatus,
  };
}

function assetKey(deptId: VerifiedDeptId, assetId: string) {
  return { pk: buildDeptScopedPk(deptId, 'ASSET', assetId), sk: 'METADATA' as const };
}

type AuditChangedFields = Record<string, { readonly old?: unknown; readonly new: unknown }>;

async function writeAuditLogEntry(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  action: 'CREATE' | 'UPDATE',
  assetId: string,
  changedFields: AuditChangedFields,
): Promise<void> {
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'AUDIT', date),
        sk: `${ts}#EQUIPMENT_ASSET#${assetId}#${actorId}`,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'EQUIPMENT_ASSET',
        mutatedEntityId: assetId,
        action,
        actorId,
        changedFields,
        ts,
        gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'EQUIPMENT_ASSET', assetId),
        gsi3sk: String(ts),
      },
    }),
  );
}

export interface CreateEquipmentAssetInput {
  readonly serialNumber: string;
  readonly location: string;
}

export async function createEquipmentAsset(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  input: CreateEquipmentAssetInput,
): Promise<EquipmentAsset> {
  const assetId = randomUUID();
  const item: EquipmentAssetItem = {
    ...assetKey(deptId, assetId),
    entityType: 'EQUIPMENT_ASSET',
    assetId,
    deptId,
    serialNumber: input.serialNumber,
    location: input.location,
    lifecycleStatus: 'ACQUIRED',
    gsi3pk: buildDeptScopedPk(deptId, 'EQUIPMENT_ASSET'),
    gsi3sk: assetId,
  };
  await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
  await writeAuditLogEntry(docClient, tableName, deptId, actorId, 'CREATE', assetId, {
    serialNumber: { new: input.serialNumber },
    location: { new: input.location },
  });
  return toEquipmentAsset(item);
}

export async function getEquipmentAsset(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  assetId: string,
): Promise<EquipmentAsset | undefined> {
  const result = await docClient.send(
    new GetCommand({ TableName: tableName, Key: assetKey(deptId, assetId) }),
  );
  return result.Item ? toEquipmentAsset(result.Item as EquipmentAssetItem) : undefined;
}

export interface ListEquipmentAssetsFilter {
  readonly assignedToType?: AssignedToType;
  readonly assignedToId?: string;
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

export async function listEquipmentAssets(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  filter: ListEquipmentAssetsFilter = {},
): Promise<readonly EquipmentAsset[]> {
  if (filter.assignedToType === 'MEMBER' && filter.assignedToId) {
    const items = await queryAllPages(docClient, {
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1Pk AND begins_with(gsi1sk, :prefix)',
      FilterExpression: 'deptId = :deptId',
      ExpressionAttributeValues: {
        ':gsi1Pk': `MEMBER#${filter.assignedToId}`,
        ':prefix': 'EQUIPMENT_ASSET#',
        ':deptId': deptId,
      },
    });
    return items
      .filter((item) => item.deptId === deptId)
      .map((item) => toEquipmentAsset(item as unknown as EquipmentAssetItem));
  }

  const expressionValues: Record<string, string> = {
    ':gsi3Pk': buildDeptScopedPk(deptId, 'EQUIPMENT_ASSET'),
  };
  let filterExpression: string | undefined;
  if (filter.assignedToType) {
    expressionValues[':type'] = filter.assignedToType;
    filterExpression = 'assignedToType = :type';
    if (filter.assignedToId) {
      expressionValues[':id'] = filter.assignedToId;
      filterExpression += ' AND assignedToId = :id';
    }
  }

  const items = await queryAllPages(docClient, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :gsi3Pk',
    ExpressionAttributeValues: expressionValues,
    ...(filterExpression ? { FilterExpression: filterExpression } : {}),
  });
  return items.map((item) => toEquipmentAsset(item as unknown as EquipmentAssetItem));
}

async function conditionalUpdate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  assetId: string,
  updateExpression: string,
  expressionValues: Record<string, string>,
  expressionNames?: Record<string, string>,
): Promise<EquipmentAsset | undefined> {
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: assetKey(deptId, assetId),
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionValues,
        ...(expressionNames ? { ExpressionAttributeNames: expressionNames } : {}),
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes
      ? toEquipmentAsset(result.Attributes as EquipmentAssetItem)
      : undefined;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return undefined;
    }
    throw error;
  }
}

export async function setAssignment(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  assetId: string,
  assignedToType: AssignedToType,
  assignedToId: string,
): Promise<EquipmentAsset | undefined> {
  const expressionValues: Record<string, string> = {
    ':type': assignedToType,
    ':id': assignedToId,
  };
  let updateExpression = 'SET assignedToType = :type, assignedToId = :id';
  if (assignedToType === 'MEMBER') {
    updateExpression += ', gsi1pk = :gsi1pk, gsi1sk = :gsi1sk';
    expressionValues[':gsi1pk'] = `MEMBER#${assignedToId}`;
    expressionValues[':gsi1sk'] = `EQUIPMENT_ASSET#${assetId}`;
  } else {
    updateExpression += ' REMOVE gsi1pk, gsi1sk';
  }
  const asset = await conditionalUpdate(
    docClient,
    tableName,
    deptId,
    assetId,
    updateExpression,
    expressionValues,
  );
  if (asset) {
    await writeAuditLogEntry(docClient, tableName, deptId, actorId, 'UPDATE', assetId, {
      assignedToType: { new: assignedToType },
      assignedToId: { new: assignedToId },
    });
  }
  return asset;
}

export async function setLocation(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  actorId: string,
  assetId: string,
  location: string,
): Promise<EquipmentAsset | undefined> {
  const asset = await conditionalUpdate(
    docClient,
    tableName,
    deptId,
    assetId,
    'SET #location = :location',
    { ':location': location },
    { '#location': 'location' },
  );
  if (asset) {
    await writeAuditLogEntry(docClient, tableName, deptId, actorId, 'UPDATE', assetId, {
      location: { new: location },
    });
  }
  return asset;
}
