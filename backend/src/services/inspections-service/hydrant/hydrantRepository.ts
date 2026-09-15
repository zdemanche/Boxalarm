import { randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { getDocumentClient, readHydrantTableConfig } from './dynamoClient.js';
import { logError } from './logger.js';
import {
  HYDRANT_SK,
  buildHydrantDueGsi2Pk,
  buildHydrantGsi2Keys,
  buildHydrantGsi3Keys,
} from './hydrantKeys.js';
import type { HydrantStatus } from './hydrantKeys.js';

export type HydrantRecord = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'HYDRANT';
  readonly hydrantId: string;
  readonly deptId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly size: string;
  readonly flowRatingGpm: number;
  readonly lastFlowTestDate?: string;
  readonly nextFlowTestDue: string;
  readonly status: HydrantStatus;
  readonly gsi2pk: string;
  readonly gsi2sk: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export interface CreateHydrantInput {
  readonly hydrantId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly size: string;
  readonly flowRatingGpm: number;
  readonly nextFlowTestDue: string;
  readonly status: HydrantStatus;
}

export interface UpdateHydrantInput {
  readonly status?: HydrantStatus;
  readonly lastFlowTestDate?: string;
  readonly nextFlowTestDue?: string;
}

export class HydrantAlreadyExistsError extends Error {
  constructor(hydrantId: string) {
    super(`hydrant "${hydrantId}" already exists`);
  }
}

export class HydrantNotFoundError extends Error {
  constructor(hydrantId: string) {
    super(`hydrant "${hydrantId}" was not found`);
  }
}

export async function createHydrant(
  deptId: VerifiedDeptId,
  input: CreateHydrantInput,
): Promise<HydrantRecord> {
  const { tableName } = readHydrantTableConfig(process.env);
  const now = Date.now();
  const gsi2 = buildHydrantGsi2Keys(deptId, input.nextFlowTestDue, input.hydrantId);
  const gsi3 = buildHydrantGsi3Keys(deptId, input.latitude, input.longitude, input.hydrantId);
  const item: HydrantRecord = {
    pk: buildDeptScopedPk(deptId, 'HYDRANT', input.hydrantId),
    sk: HYDRANT_SK,
    entityType: 'HYDRANT',
    hydrantId: input.hydrantId,
    deptId,
    latitude: input.latitude,
    longitude: input.longitude,
    size: input.size,
    flowRatingGpm: input.flowRatingGpm,
    nextFlowTestDue: input.nextFlowTestDue,
    status: input.status,
    ...gsi2,
    ...gsi3,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new HydrantAlreadyExistsError(input.hydrantId);
    }
    throw error;
  }

  return item;
}

export async function updateHydrant(
  deptId: VerifiedDeptId,
  hydrantId: string,
  patch: UpdateHydrantInput,
  correlationId: string,
): Promise<HydrantRecord> {
  const { tableName } = readHydrantTableConfig(process.env);
  const pk = buildDeptScopedPk(deptId, 'HYDRANT', hydrantId);
  const now = Date.now();

  const setClauses: string[] = ['updatedAt = :updatedAt'];
  const names: Record<string, string> = {};
  const values: Record<string, string | number> = { ':updatedAt': now };

  if (patch.status !== undefined) {
    setClauses.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = patch.status;
  }
  if (patch.lastFlowTestDate !== undefined) {
    setClauses.push('lastFlowTestDate = :lastFlowTestDate');
    values[':lastFlowTestDate'] = patch.lastFlowTestDate;
  }
  if (patch.nextFlowTestDue !== undefined) {
    const gsi2 = buildHydrantGsi2Keys(deptId, patch.nextFlowTestDue, hydrantId);
    setClauses.push('nextFlowTestDue = :nextFlowTestDue', 'gsi2pk = :gsi2pk', 'gsi2sk = :gsi2sk');
    values[':nextFlowTestDue'] = patch.nextFlowTestDue;
    values[':gsi2pk'] = gsi2.gsi2pk;
    values[':gsi2sk'] = gsi2.gsi2sk;
  }

  // No ttl here, deliberately (matches personnel-service's OUTBOX_ENTRY precedent): an
  // unpublished event must never be silently dropped by a timer. inspections.hydrant.updated
  // has no defined transport yet (architecture §4.2/§5 name neither a topic/queue nor an
  // event-schema row for it) — that's a companion infra decision, out of this repo's reach,
  // not something this write path should paper over by expiring the durable evidence of it.
  const eventId = randomUUID();
  const outboxItem = {
    pk,
    sk: `OUTBOX#${eventId}`,
    entityType: 'OUTBOX_EVENT',
    eventId,
    eventTime: new Date(now).toISOString(),
    eventType: 'inspections.hydrant.updated',
    source: 'inspections-service',
    correlationId,
    schemaVersion: '1.0',
    payload: { hydrantId, deptId, ...patch },
  };

  try {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: HYDRANT_SK },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: `SET ${setClauses.join(', ')}`,
              ExpressionAttributeValues: values,
              ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: outboxItem,
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      logError({
        event: 'hydrant.update.transact_failed',
        service: 'inspections-service',
        correlationId,
        hydrantId,
        reasons: error.CancellationReasons?.map((reason) => reason.Code),
        message: error.message,
      });
      if (error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        throw new HydrantNotFoundError(hydrantId);
      }
    }
    throw error;
  }

  const persisted = await getDocumentClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: HYDRANT_SK },
      ConsistentRead: true,
    }),
  );
  if (!persisted.Item) {
    throw new HydrantNotFoundError(hydrantId);
  }
  return persisted.Item as HydrantRecord;
}

export async function queryHydrantsDueWithin(
  deptId: VerifiedDeptId,
  yyyyMm: string,
): Promise<readonly HydrantRecord[]> {
  const { tableName } = readHydrantTableConfig(process.env);
  const result = await getDocumentClient().send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ExpressionAttributeValues: { ':gsi2pk': buildHydrantDueGsi2Pk(deptId, yyyyMm) },
    }),
  );
  return (result.Items ?? []) as unknown as readonly HydrantRecord[];
}
