import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { InventoryConfig } from '../lifecycle/repository.js';

export {
  createInventoryDynamoClient,
  readInventoryConfig,
  type InventoryConfig,
} from '../lifecycle/repository.js';

export type PpeStatus = 'ISSUED' | 'RETIRED' | 'EXPIRED';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PpeAssignmentConflictError extends Error {
  constructor(readonly ppeItemId: string) {
    super(`PPE item "${ppeItemId}" is already issued to this member`);
    this.name = 'PpeAssignmentConflictError';
  }
}

export function ppeItemIdForType(itemType: string): string {
  return itemType.replace(/_/g, '-');
}

export function computeNfpaExpiryDate(issueDate: string): string {
  if (!ISO_DATE.test(issueDate)) {
    throw new Error(`issueDate must be an ISO date (YYYY-MM-DD): received "${issueDate}"`);
  }
  const [year, month, day] = issueDate.split('-').map(Number) as [number, number, number];
  const expiry = new Date(Date.UTC(year + 10, month - 1, day));
  return expiry.toISOString().slice(0, 10);
}

export function derivePpeStatus(
  stored: PpeStatus,
  nfpaExpiryDate: string,
  now: Date,
): PpeStatus {
  if (stored === 'RETIRED') {
    return 'RETIRED';
  }
  const today = now.toISOString().slice(0, 10);
  return today > nfpaExpiryDate ? 'EXPIRED' : 'ISSUED';
}

function logRepositoryError(
  event: string,
  error: unknown,
  correlationId: string,
  ppeItemId?: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'inventory',
      reason: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
      correlationId,
      ...(ppeItemId ? { ppeItemId } : {}),
    }),
  );
}

export interface PpeAssignmentRecord {
  readonly ppeItemId: string;
  readonly memberId: string;
  readonly itemType: string;
  readonly size: string;
  readonly issueDate: string;
  readonly nfpaExpiryDate: string;
  readonly status: PpeStatus;
}

export interface IssuePpeAssignmentParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly itemType: string;
  readonly size: string;
  readonly issueDate: string;
  readonly now: Date;
}

export async function issuePpeAssignment(
  client: DynamoDBDocumentClient,
  config: InventoryConfig,
  params: IssuePpeAssignmentParams,
): Promise<PpeAssignmentRecord> {
  const { tableName } = config;
  const ppeItemId = ppeItemIdForType(params.itemType);
  const nfpaExpiryDate = computeNfpaExpiryDate(params.issueDate);
  const yearMonth = nfpaExpiryDate.slice(0, 7);

  const item = {
    pk: buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId),
    sk: `PPE#${ppeItemId}`,
    entityType: 'PPE_ASSIGNMENT',
    ppeItemId,
    memberId: params.memberId,
    itemType: params.itemType,
    size: params.size,
    issueDate: params.issueDate,
    nfpaExpiryDate,
    status: 'ISSUED',
    gsi1pk: `MEMBER#${params.memberId}`,
    gsi1sk: `PPE_ASSIGNMENT#${nfpaExpiryDate}`,
    gsi2pk: buildDeptScopedPk(params.deptId, 'DUE', 'PPE_ASSIGNMENT', yearMonth),
    gsi2sk: `${nfpaExpiryDate}#${ppeItemId}`,
  };

  const ts = Math.floor(params.now.getTime() / 1000);
  const date = params.now.toISOString().slice(0, 10);
  const auditPut = {
    Put: {
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(params.deptId, 'AUDIT', date),
        sk: `${ts}#PPE_ASSIGNMENT#${ppeItemId}#${params.actorId}`,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'PPE_ASSIGNMENT',
        mutatedEntityId: ppeItemId,
        action: 'CREATE',
        actorId: params.actorId,
        changedFields: {
          itemType: { old: null, new: params.itemType },
          size: { old: null, new: params.size },
          issueDate: { old: null, new: params.issueDate },
        },
        ts,
        gsi3pk: buildDeptScopedPk(params.deptId, 'AUDIT', 'ENTITY', 'PPE_ASSIGNMENT', ppeItemId),
        gsi3sk: `${ts}`,
      },
    },
  };

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          auditPut,
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      throw new PpeAssignmentConflictError(ppeItemId);
    }
    logRepositoryError('ppe.issue.failed', error, params.correlationId, ppeItemId);
    throw error;
  }

  return {
    ppeItemId,
    memberId: params.memberId,
    itemType: params.itemType,
    size: params.size,
    issueDate: params.issueDate,
    nfpaExpiryDate,
    status: 'ISSUED',
  };
}

function toPpeAssignmentRecord(item: Record<string, unknown>, now: Date): PpeAssignmentRecord {
  const stored = item.status as PpeStatus;
  const nfpaExpiryDate = item.nfpaExpiryDate as string;
  return {
    ppeItemId: item.ppeItemId as string,
    memberId: item.memberId as string,
    itemType: item.itemType as string,
    size: item.size as string,
    issueDate: item.issueDate as string,
    nfpaExpiryDate,
    status: derivePpeStatus(stored, nfpaExpiryDate, now),
  };
}

export interface ListPpeAssignmentsParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly correlationId: string;
  readonly now: Date;
}

export async function listPpeAssignmentsForMember(
  client: DynamoDBDocumentClient,
  config: InventoryConfig,
  params: ListPpeAssignmentsParams,
): Promise<readonly PpeAssignmentRecord[]> {
  try {
    const output = await client.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId),
          ':skPrefix': 'PPE#',
        },
      }),
    );
    return (output.Items ?? []).map((item) => toPpeAssignmentRecord(item, params.now));
  } catch (error) {
    logRepositoryError('ppe.list.failed', error, params.correlationId);
    throw error;
  }
}

export interface PpeDueRecord {
  readonly memberId: string;
  readonly ppeItemId: string;
  readonly expiryDate: string;
}

export interface QueryPpeAssignmentsDueInMonthParams {
  readonly deptId: VerifiedDeptId;
  readonly yearMonth: string;
  readonly correlationId: string;
}

export async function queryPpeAssignmentsDueInMonth(
  client: DynamoDBDocumentClient,
  config: InventoryConfig,
  params: QueryPpeAssignmentsDueInMonthParams,
): Promise<readonly PpeDueRecord[]> {
  try {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await client.send(
        new QueryCommand({
          TableName: config.tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'gsi2pk = :gsi2pk',
          ExpressionAttributeValues: {
            ':gsi2pk': buildDeptScopedPk(params.deptId, 'DUE', 'PPE_ASSIGNMENT', params.yearMonth),
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(output.Items ?? []));
      exclusiveStartKey = output.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items.map((item) => ({
      memberId: item.memberId as string,
      ppeItemId: item.ppeItemId as string,
      expiryDate: item.nfpaExpiryDate as string,
    }));
  } catch (error) {
    logRepositoryError('ppe.queryDueInMonth.failed', error, params.correlationId);
    throw error;
  }
}
