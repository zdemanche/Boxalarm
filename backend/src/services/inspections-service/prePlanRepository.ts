import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { buildAssetKey } from './assetsSigner.js';
import { logError } from './logger.js';

export interface UtilityShutoff {
  readonly utility: string;
  readonly location: string;
}

export interface PrePlanInput {
  readonly siteDiagramFilename?: string;
  readonly attachmentFilenames: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly hazards: readonly string[];
}

export type PrePlanItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'PRE_PLAN';
  readonly prePlanId: string;
  readonly siteDiagramS3Key: string | null;
  readonly attachmentS3Keys: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly hazards: readonly string[];
  readonly updatedAt: number;
};

export class PrePlanDependencyError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'PrePlanDependencyError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export class OccupancyNotFoundError extends Error {
  constructor(occupancyId: string) {
    super(`Occupancy ${occupancyId} does not exist`);
    this.name = 'OccupancyNotFoundError';
  }
}

export class PrePlanConflictError extends Error {
  constructor(occupancyId: string) {
    super(`A pre-plan for occupancy ${occupancyId} was created concurrently; retry the request`);
    this.name = 'PrePlanConflictError';
  }
}

export async function getPrePlan(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  occupancyId: string,
): Promise<PrePlanItem | undefined> {
  try {
    const output = await doc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId),
          ':skPrefix': 'PREPLAN#',
        },
        Limit: 1,
      }),
    );
    return output.Items?.[0] as PrePlanItem | undefined;
  } catch (error) {
    logError({
      event: 'preplan.query_failed',
      service: 'inspections-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      deptId,
      occupancyId,
    });
    throw new PrePlanDependencyError(error);
  }
}

export async function putPrePlan(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  occupancyId: string,
  input: PrePlanInput,
): Promise<PrePlanItem> {
  const existing = await getPrePlan(doc, tableName, deptId, occupancyId);
  const isCreate = existing === undefined;
  const prePlanId = existing?.prePlanId ?? randomUUID();
  const item: PrePlanItem = {
    pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId),
    sk: `PREPLAN#${prePlanId}`,
    entityType: 'PRE_PLAN',
    prePlanId,
    siteDiagramS3Key: input.siteDiagramFilename
      ? buildAssetKey(deptId, 'PRE_PLAN', prePlanId, input.siteDiagramFilename)
      : null,
    attachmentS3Keys: input.attachmentFilenames.map((filename) =>
      buildAssetKey(deptId, 'PRE_PLAN', prePlanId, filename),
    ),
    utilityShutoffs: input.utilityShutoffs,
    hazards: input.hazards,
    updatedAt: Date.now(),
  };
  const outboxRecord = buildOutboxRecord(
    deptId,
    'inspections-service',
    'inspections.preplan.updated',
    prePlanId,
    { deptId, occupancyId, prePlanId },
  );

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: 'METADATA' },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: item,
              ...(isCreate ? { ConditionExpression: 'attribute_not_exists(sk)' } : {}),
            },
          },
          { Put: { TableName: tableName, Item: outboxRecord } },
        ],
      }),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException ? error.CancellationReasons : undefined;
    logError({
      event: 'preplan.transact_write_failed',
      service: 'inspections-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      deptId,
      occupancyId,
      prePlanId,
      cancellationReasons: cancellationReasons?.map((reason) => reason.Code),
    });
    if (cancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      throw new OccupancyNotFoundError(occupancyId);
    }
    if (isCreate && cancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
      throw new PrePlanConflictError(occupancyId);
    }
    throw new PrePlanDependencyError(error);
  }

  return item;
}
