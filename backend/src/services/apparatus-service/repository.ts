import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ApparatusStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

const APPARATUS_STATUSES: readonly ApparatusStatus[] = ['IN_SERVICE', 'OUT_OF_SERVICE'];

export function isApparatusStatus(value: unknown): value is ApparatusStatus {
  return typeof value === 'string' && (APPARATUS_STATUSES as readonly string[]).includes(value);
}

export interface ApparatusRecord {
  readonly unitId: string;
  readonly type: string;
  readonly status: ApparatusStatus;
}

export interface OutOfServiceSummary {
  readonly reason: string;
  readonly startAt: number;
  readonly elapsedSeconds: number;
}

export interface ApparatusListItem extends ApparatusRecord {
  readonly outOfService?: OutOfServiceSummary;
}

export interface SetServiceStatusInput {
  readonly deptId: VerifiedDeptId;
  readonly unitId: string;
  readonly status: ApparatusStatus;
  readonly reason?: string;
}

export class ApparatusNotFoundError extends Error {
  constructor(unitId: string) {
    super(`Apparatus ${unitId} was not found`);
    this.name = 'ApparatusNotFoundError';
  }
}

export class ServiceStatusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceStatusConflictError';
  }
}

export class ApparatusRepositoryUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('The apparatus data store is temporarily unavailable');
    this.name = 'ApparatusRepositoryUnavailableError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export function logError(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'apparatus',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...fields,
    }),
  );
}

function emitApparatusMetric(outcome: string, reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/apparatus',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

async function withRepositoryErrorHandling<T>(
  operation: string,
  deptId: string,
  unitId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logError(`apparatus.${operation}.failed`, error, { deptId, ...(unitId ? { unitId } : {}) });
    throw new ApparatusRepositoryUnavailableError(error);
  }
}

interface ApparatusItem extends ApparatusRecord {
  readonly apparatusId: string;
  readonly outOfServiceReason?: string;
  readonly outOfServiceStartAt?: number;
}

function apparatusIdFromRegistryKey(registryItemKey: string): string {
  return registryItemKey.slice(registryItemKey.lastIndexOf('#') + 1);
}

async function findApparatusItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
): Promise<ApparatusItem | undefined> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :registryKey AND gsi3sk = :unitId',
      ExpressionAttributeValues: {
        ':registryKey': buildDeptScopedPk(deptId, 'APPARATUS'),
        ':unitId': unitId,
      },
      Limit: 1,
    }),
  );
  const item = output.Items?.[0];
  if (!item) {
    return undefined;
  }
  const registryItemKey = item.pk as string;
  return {
    apparatusId: apparatusIdFromRegistryKey(registryItemKey),
    unitId: item.unitId as string,
    type: item.type as string,
    status: item.status as ApparatusStatus,
    ...(item.outOfServiceReason !== undefined
      ? { outOfServiceReason: item.outOfServiceReason as string }
      : {}),
    ...(item.outOfServiceStartAt !== undefined
      ? { outOfServiceStartAt: item.outOfServiceStartAt as number }
      : {}),
  };
}

export async function getApparatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
): Promise<ApparatusRecord | undefined> {
  return withRepositoryErrorHandling('getApparatus', deptId, unitId, async () => {
    const item = await findApparatusItem(client, tableName, deptId, unitId);
    return item ? { unitId: item.unitId, type: item.type, status: item.status } : undefined;
  });
}

interface OpenOutOfServiceRecord {
  readonly sk: string;
  readonly reason: string;
  readonly startAt: number;
}

async function findOpenOutOfServiceRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  apparatusPk: string,
): Promise<OpenOutOfServiceRecord | undefined> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :apparatusPk AND begins_with(sk, :prefix)',
      FilterExpression: 'attribute_not_exists(endAt)',
      ExpressionAttributeValues: { ':apparatusPk': apparatusPk, ':prefix': 'OOS#' },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = output.Items?.[0];
  return item
    ? { sk: item.sk as string, reason: item.reason as string, startAt: item.startAt as number }
    : undefined;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function setServiceStatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: SetServiceStatusInput,
): Promise<void> {
  const existing = await findApparatusItem(client, tableName, input.deptId, input.unitId);
  if (!existing) {
    throw new ApparatusNotFoundError(input.unitId);
  }
  if (existing.status === input.status) {
    throw new ServiceStatusConflictError(`Apparatus ${input.unitId} is already ${input.status}`);
  }

  const statusUpdate =
    input.status === 'OUT_OF_SERVICE'
      ? {
          Update: {
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(input.deptId, 'APPARATUS', existing.apparatusId),
              sk: 'METADATA',
            },
            UpdateExpression:
              'SET #status = :next, outOfServiceReason = :reason, outOfServiceStartAt = :startAt',
            ConditionExpression: '#status = :prev',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':next': input.status,
              ':prev': existing.status,
              ':reason': input.reason,
              ':startAt': epochSeconds(),
            },
          },
        }
      : {
          Update: {
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(input.deptId, 'APPARATUS', existing.apparatusId),
              sk: 'METADATA',
            },
            UpdateExpression: 'SET #status = :next REMOVE outOfServiceReason, outOfServiceStartAt',
            ConditionExpression: '#status = :prev',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':next': input.status, ':prev': existing.status },
          },
        };

  try {
    if (input.status === 'OUT_OF_SERVICE') {
      const startAt = epochSeconds();
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            statusUpdate,
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(input.deptId, 'APPARATUS', existing.apparatusId),
                  sk: `OOS#${startAt}`,
                  entityType: 'OUT_OF_SERVICE_RECORD',
                  reason: input.reason,
                  startAt,
                },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );
      emitApparatusMetric('OutOfServiceRecorded');
    } else {
      const registryItemKey = buildDeptScopedPk(input.deptId, 'APPARATUS', existing.apparatusId);
      const openRecord = await findOpenOutOfServiceRecord(client, tableName, registryItemKey);
      if (!openRecord) {
        throw new ServiceStatusConflictError(
          `Apparatus ${input.unitId} has no open out-of-service record`,
        );
      }
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            statusUpdate,
            {
              Update: {
                TableName: tableName,
                Key: {
                  pk: buildDeptScopedPk(input.deptId, 'APPARATUS', existing.apparatusId),
                  sk: openRecord.sk,
                },
                UpdateExpression: 'SET endAt = :endAt',
                ConditionExpression: 'attribute_not_exists(endAt)',
                ExpressionAttributeValues: { ':endAt': epochSeconds() },
              },
            },
          ],
        }),
      );
      emitApparatusMetric('ReturnedToService');
    }
  } catch (error) {
    if (error instanceof ServiceStatusConflictError) {
      throw error;
    }
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons ?? []).map((entry) => entry.Code)
        : undefined;
    logError('apparatus.setServiceStatus.failed', error, {
      deptId: input.deptId,
      unitId: input.unitId,
      ...(cancellationReasons ? { cancellationReasons } : {}),
    });
    if (cancellationReasons?.includes('ConditionalCheckFailed')) {
      emitApparatusMetric('ServiceStatusChangeFailed', 'Conflict');
      throw new ServiceStatusConflictError(
        `Apparatus ${input.unitId} is not in a state that allows this transition`,
      );
    }
    emitApparatusMetric('ServiceStatusChangeFailed', 'Unavailable');
    throw new ApparatusRepositoryUnavailableError(error);
  }
}

export async function listApparatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  statusFilter?: ApparatusStatus,
): Promise<readonly ApparatusListItem[]> {
  return withRepositoryErrorHandling('listApparatus', deptId, undefined, async () => {
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :scopedRegistryKey',
        ExpressionAttributeValues: {
          ':scopedRegistryKey': buildDeptScopedPk(deptId, 'APPARATUS'),
        },
      }),
    );
    const items = output.Items ?? [];
    const filtered = statusFilter ? items.filter((item) => item.status === statusFilter) : items;
    return filtered.map((item): ApparatusListItem => {
      const unitId = item.unitId as string;
      const type = item.type as string;
      const status = item.status as ApparatusStatus;
      const startAt = item.outOfServiceStartAt as number | undefined;
      if (status !== 'OUT_OF_SERVICE' || startAt === undefined) {
        return { unitId, type, status };
      }
      return {
        unitId,
        type,
        status,
        outOfService: {
          reason: item.outOfServiceReason as string,
          startAt,
          elapsedSeconds: Math.max(0, epochSeconds() - startAt),
        },
      };
    });
  });
}
