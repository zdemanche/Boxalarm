import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError } from '../dispatches/logger.js';

export type UtilityShutoff = Record<string, unknown>;
export type HydrantRef = Record<string, unknown>;

export interface PrePlanCopyItem {
  readonly summary?: string;
  readonly hazards: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly nearestHydrants: readonly HydrantRef[];
  readonly snapshotUpdatedAt: number;
}

export class PrePlanCopyDependencyError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'PrePlanCopyDependencyError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function getPrePlanCopy(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  occupancyId: string,
): Promise<PrePlanCopyItem | undefined> {
  try {
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'PREPLAN'),
          ':sk': `OCCUPANCY#${occupancyId}`,
        },
        Limit: 1,
      }),
    );
    return output.Items?.[0] as PrePlanCopyItem | undefined;
  } catch (error) {
    logError('preplan_copy.query_failed', error, { deptId, occupancyId });
    throw new PrePlanCopyDependencyError(error);
  }
}
