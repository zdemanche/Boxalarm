import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildInspectionKeys, type InspectionItem, type Violation } from '../inspectionRecord.js';
import { logError, logInfo } from '../logger.js';

export interface SubmitFieldCaptureInput {
  readonly deptId: VerifiedDeptId;
  readonly occupancyId: string;
  readonly inspectionId: string;
  readonly idempotencyKey: string;
  readonly violations: readonly Violation[];
  readonly photoS3Keys: readonly string[];
  readonly conductedBy: string;
  readonly submittedAt: string;
  readonly conductedAt?: string;
}

export type SubmitFieldCaptureResult =
  | { readonly outcome: 'created'; readonly item: InspectionItem }
  | { readonly outcome: 'duplicate'; readonly item: InspectionItem };

export class FieldCaptureDependencyError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'FieldCaptureDependencyError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export class FieldCaptureOccupancyNotFoundError extends Error {
  readonly occupancyId: string;

  constructor(occupancyId: string) {
    super(`Occupancy ${occupancyId} does not exist`);
    this.name = 'FieldCaptureOccupancyNotFoundError';
    this.occupancyId = occupancyId;
  }
}

export class FieldCaptureInspectionNotFoundError extends Error {
  readonly inspectionId: string;

  constructor(inspectionId: string) {
    super(`Inspection ${inspectionId} does not exist to attach a field capture to`);
    this.name = 'FieldCaptureInspectionNotFoundError';
    this.inspectionId = inspectionId;
  }
}

const LOCK_ITEM_INDEX = 0;
const OCCUPANCY_CHECK_INDEX = 1;
const DOMAIN_ITEM_INDEX = 2;

export async function submitFieldCapture(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: SubmitFieldCaptureInput,
): Promise<SubmitFieldCaptureResult> {
  const {
    deptId,
    occupancyId,
    inspectionId,
    idempotencyKey,
    violations,
    photoS3Keys,
    conductedBy,
    submittedAt,
    conductedAt,
  } = input;
  const { pk, sk } = buildInspectionKeys(deptId, occupancyId, inspectionId);

  let existingItem: InspectionItem | undefined;
  try {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    existingItem = existing.Item as InspectionItem | undefined;
  } catch (error) {
    logError({
      event: 'fieldCapture.submit.lookup_failed',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      deptId,
      occupancyId,
      inspectionId,
    });
    throw new FieldCaptureDependencyError(error);
  }

  if (!existingItem) {
    throw new FieldCaptureInspectionNotFoundError(inspectionId);
  }

  const conductedDate = conductedAt ?? submittedAt;

  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(deptId, 'FIELD_CAPTURE_IDEMPOTENCY', idempotencyKey),
            sk: 'LOCK',
            entityType: 'FIELD_CAPTURE_IDEMPOTENCY_LOCK',
            idempotencyKey,
            occupancyId,
            inspectionId,
            createdAt: submittedAt,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: 'METADATA' },
          ConditionExpression: 'attribute_exists(pk)',
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk },
          ConditionExpression: 'attribute_exists(sk)',
          UpdateExpression:
            'SET conductedDate = :conductedDate, conductedBy = :conductedBy, violations = :violations, photoS3Keys = :photoS3Keys',
          ExpressionAttributeValues: {
            ':conductedDate': conductedDate,
            ':conductedBy': conductedBy,
            ':violations': violations,
            ':photoS3Keys': photoS3Keys,
          },
        },
      },
    ],
  });

  try {
    await client.send(command);
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const reasons = error.CancellationReasons;
      if (reasons?.[LOCK_ITEM_INDEX]?.Code === 'ConditionalCheckFailed') {
        logInfo({
          event: 'fieldCapture.submit.duplicate',
          deptId,
          occupancyId,
          inspectionId,
          idempotencyKey,
        });
        return { outcome: 'duplicate', item: existingItem };
      }
      if (reasons?.[OCCUPANCY_CHECK_INDEX]?.Code === 'ConditionalCheckFailed') {
        logError({
          event: 'fieldCapture.submit.occupancy_not_found',
          reason: error.constructor.name,
          deptId,
          occupancyId,
          inspectionId,
        });
        throw new FieldCaptureOccupancyNotFoundError(occupancyId);
      }
      if (reasons?.[DOMAIN_ITEM_INDEX]?.Code === 'ConditionalCheckFailed') {
        logError({
          event: 'fieldCapture.submit.inspection_not_found',
          reason: error.constructor.name,
          deptId,
          occupancyId,
          inspectionId,
        });
        throw new FieldCaptureInspectionNotFoundError(inspectionId);
      }
    }
    logError({
      event: 'fieldCapture.submit.transact_write_failed',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      deptId,
      occupancyId,
      inspectionId,
    });
    throw new FieldCaptureDependencyError(error);
  }

  const item: InspectionItem = {
    ...existingItem,
    conductedDate,
    conductedBy,
    violations,
    photoS3Keys,
  };
  return { outcome: 'created', item };
}
