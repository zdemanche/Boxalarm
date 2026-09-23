import { randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const SK_PREFIX = 'COMPARTMENT_ITEM#';

export interface CompartmentItemInput {
  readonly compartmentCode: string;
  readonly itemName: string;
  readonly quantity: number;
}

export interface CompartmentItemRecord extends CompartmentItemInput {
  readonly itemId: string;
}

export class CompartmentItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Compartment item ${itemId} was not found`);
    this.name = 'CompartmentItemNotFoundError';
  }
}

export class CompartmentItemInvalidKeyError extends Error {
  constructor(field: string, value: string) {
    super(
      `${field} cannot contain '#', the department-scoped pk/sk delimiter: received "${value}"`,
    );
    this.name = 'CompartmentItemInvalidKeyError';
  }
}

export class CompartmentItemStoreUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'CompartmentItemStoreUnavailableError';
    this.cause = cause;
    // mirrors AuthzUnavailableError's documented caveat
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

function assertKeySafe(value: string, field: string): void {
  if (value.includes('#')) {
    throw new CompartmentItemInvalidKeyError(field, value);
  }
}

function isConditionalCheckFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) {
    return true;
  }
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
}

function logStoreError(event: string, context: Record<string, string>, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      service: 'apparatus-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

function toRecord(item: Record<string, unknown>): CompartmentItemRecord {
  const sk = String(item.sk);
  return {
    itemId: sk.slice(SK_PREFIX.length),
    compartmentCode: String(item.compartmentCode),
    itemName: String(item.itemName),
    quantity: Number(item.quantity),
  };
}

function buildAuditEntry(
  deptId: VerifiedDeptId,
  itemId: string,
  actorId: string,
  action: 'CREATE' | 'UPDATE',
  changedFields: Record<string, { old: unknown; new: unknown }>,
): Record<string, unknown> {
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  return {
    pk: buildDeptScopedPk(deptId, 'AUDIT', date),
    sk: `${ts}#COMPARTMENT_ITEM#${itemId}#${actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: 'COMPARTMENT_ITEM',
    mutatedEntityId: itemId,
    action,
    actorId,
    changedFields,
    ts,
  };
}

export async function listCompartmentItems(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
): Promise<readonly CompartmentItemRecord[]> {
  assertKeySafe(unitId, 'unitId');
  const pk = buildDeptScopedPk(deptId, 'APPARATUS', unitId);
  try {
    // ConsistentRead: true — AC2's "reflects immediately" comes from a strongly consistent
    // single-table read on the same pk a write just landed on, no cache/GSI/event in the path.
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pkValue AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: { ':pkValue': pk, ':skPrefix': SK_PREFIX },
        ConsistentRead: true,
      }),
    );
    return (output.Items ?? []).map(toRecord);
  } catch (error) {
    logStoreError('inventory.list.storeError', { deptId, unitId }, error);
    throw new CompartmentItemStoreUnavailableError(error);
  }
}

export async function putCompartmentItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
  input: CompartmentItemInput,
  actorId: string,
): Promise<CompartmentItemRecord> {
  assertKeySafe(unitId, 'unitId');
  const pk = buildDeptScopedPk(deptId, 'APPARATUS', unitId);
  const itemId = randomUUID();
  const auditEntry = buildAuditEntry(deptId, itemId, actorId, 'CREATE', {
    compartmentCode: { old: null, new: input.compartmentCode },
    itemName: { old: null, new: input.itemName },
    quantity: { old: null, new: input.quantity },
  });
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: { pk, sk: `${SK_PREFIX}${itemId}`, entityType: 'COMPARTMENT_ITEM', ...input },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          { Put: { TableName: tableName, Item: auditEntry } },
        ],
      }),
    );
  } catch (error) {
    logStoreError('inventory.create.storeError', { deptId, unitId, itemId }, error);
    throw new CompartmentItemStoreUnavailableError(error);
  }
  return { itemId, ...input };
}

export async function updateCompartmentItemQuantity(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
  itemId: string,
  quantity: number,
  actorId: string,
): Promise<void> {
  assertKeySafe(unitId, 'unitId');
  assertKeySafe(itemId, 'itemId');
  const pk = buildDeptScopedPk(deptId, 'APPARATUS', unitId);
  const sk = `${SK_PREFIX}${itemId}`;
  try {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    const oldQuantity =
      existing.Item && existing.Item.quantity !== undefined ? Number(existing.Item.quantity) : null;
    const auditEntry = buildAuditEntry(deptId, itemId, actorId, 'UPDATE', {
      quantity: { old: oldQuantity, new: quantity },
    });
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              UpdateExpression: 'SET quantity = :quantity',
              ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
              ExpressionAttributeValues: { ':quantity': quantity },
            },
          },
          { Put: { TableName: tableName, Item: auditEntry } },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      logStoreError('inventory.updateQuantity.notFound', { deptId, unitId, itemId }, error);
      throw new CompartmentItemNotFoundError(itemId);
    }
    logStoreError('inventory.updateQuantity.storeError', { deptId, unitId, itemId }, error);
    throw new CompartmentItemStoreUnavailableError(error);
  }
}
