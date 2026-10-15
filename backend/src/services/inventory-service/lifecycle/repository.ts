import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type LifecycleStatus = 'ACQUIRED' | 'IN_SERVICE' | 'RETIRED';

// TODO: E4-S11 — POST /api/v1/inventory/equipment must default lifecycleStatus to this constant
export const DEFAULT_LIFECYCLE_STATUS: LifecycleStatus = 'ACQUIRED';

export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  ACQUIRED: ['IN_SERVICE', 'RETIRED'],
  IN_SERVICE: ['RETIRED'],
  RETIRED: [],
};

export interface EquipmentAsset {
  readonly assetId: string;
  readonly lifecycleStatus: LifecycleStatus;
}

export interface InventoryConfig {
  readonly tableName: string;
}

export function readInventoryConfig(env: NodeJS.ProcessEnv): InventoryConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createInventoryDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readInventoryConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export class LifecycleTransitionConflictError extends Error {
  constructor(assetId: string) {
    super(`Lifecycle transition for asset "${assetId}" lost a concurrent-update race`);
    this.name = 'LifecycleTransitionConflictError';
  }
}

export async function getEquipmentAsset(
  client: DynamoDBDocumentClient,
  config: InventoryConfig,
  deptId: VerifiedDeptId,
  assetId: string,
): Promise<EquipmentAsset | undefined> {
  const output = await client.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'ASSET', assetId), sk: 'METADATA' },
    }),
  );
  if (!output.Item) {
    return undefined;
  }
  const lifecycleStatus =
    (output.Item.lifecycleStatus as LifecycleStatus | undefined) ?? DEFAULT_LIFECYCLE_STATUS;
  return { assetId, lifecycleStatus };
}

export async function transitionLifecycleStatus(
  client: DynamoDBDocumentClient,
  config: InventoryConfig,
  deptId: VerifiedDeptId,
  actorId: string,
  assetId: string,
  from: LifecycleStatus,
  to: LifecycleStatus,
): Promise<EquipmentAsset> {
  const dropsAssignmentEligibility = !isAssignmentEligible(to);
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'ASSET', assetId), sk: 'METADATA' },
              UpdateExpression: dropsAssignmentEligibility
                ? 'SET lifecycleStatus = :to REMOVE gsi1pk, gsi1sk'
                : 'SET lifecycleStatus = :to',
              ConditionExpression: 'attribute_exists(pk) AND lifecycleStatus = :from',
              ExpressionAttributeValues: { ':to': to, ':from': from },
            },
          },
          {
            Put: {
              TableName: config.tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'AUDIT', date),
                sk: `${ts}#EQUIPMENT_ASSET#${assetId}#${actorId}`,
                entityType: 'AUDIT_LOG_ENTRY',
                mutatedEntityType: 'EQUIPMENT_ASSET',
                mutatedEntityId: assetId,
                action: 'UPDATE',
                actorId,
                changedFields: { lifecycleStatus: { old: from, new: to } },
                ts,
                gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'EQUIPMENT_ASSET', assetId),
                gsi3sk: String(ts),
              },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
    return { assetId, lifecycleStatus: to };
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      throw new LifecycleTransitionConflictError(assetId);
    }
    throw error;
  }
}

export function isAssignmentEligible(lifecycleStatus: LifecycleStatus): boolean {
  return lifecycleStatus !== 'RETIRED';
}
