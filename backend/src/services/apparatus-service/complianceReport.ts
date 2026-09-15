import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import { apparatusIdFromPartitionKey } from './checklistResolution.js';
import {
  ApparatusRepositoryUnavailableError,
  logError,
  type ApparatusListItem,
} from './repository.js';

const SECONDS_PER_DAY = 86400;
const EPOCH_SORT_KEY_WIDTH = 10;
export const MAX_RANGE_SECONDS = 400 * SECONDS_PER_DAY;

export interface ChecklistRunSummary {
  readonly apparatusId: string;
  readonly completedAt: number;
}

export interface ApparatusComplianceEntry {
  readonly unitId: string;
  readonly expectedChecks: number;
  readonly actualChecks: number;
  readonly compliant: boolean;
}

function buildEpochSortKey(epochSeconds: number): string {
  return String(Math.trunc(epochSeconds)).padStart(EPOCH_SORT_KEY_WIDTH, '0');
}

function toChecklistRunSummary(item: Record<string, unknown>): ChecklistRunSummary | undefined {
  const partitionKey = item.pk;
  const completedAt = item.completedAt;
  if (typeof partitionKey !== 'string' || typeof completedAt !== 'number') {
    return undefined;
  }
  const apparatusId = apparatusIdFromPartitionKey(partitionKey);
  return apparatusId ? { apparatusId, completedAt } : undefined;
}

export async function queryChecklistRunsInRange(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  fromEpoch: number,
  toEpoch: number,
): Promise<readonly ChecklistRunSummary[]> {
  try {
    const summaries: ChecklistRunSummary[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI3_INDEX_NAME,
          KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk BETWEEN :from AND :to',
          ProjectionExpression: 'pk, completedAt',
          ExpressionAttributeValues: {
            ':gsi3pk': buildDeptScopedPk(deptId, 'CHECKLIST_RUN'),
            ':from': buildEpochSortKey(fromEpoch),
            ':to': buildEpochSortKey(toEpoch),
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of result.Items ?? []) {
        const summary = toChecklistRunSummary(item);
        if (summary) {
          summaries.push(summary);
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return summaries;
  } catch (error) {
    logError('apparatus.complianceReport.queryChecklistRuns.failed', error, { deptId });
    throw new ApparatusRepositoryUnavailableError(error);
  }
}

function dayIndexUtc(epochSeconds: number): number {
  return Math.floor(epochSeconds / SECONDS_PER_DAY);
}

function expectedChecksForRange(fromEpoch: number, toEpoch: number): number {
  return dayIndexUtc(toEpoch) - dayIndexUtc(fromEpoch) + 1;
}

export function computeComplianceReport(
  roster: readonly ApparatusListItem[],
  runs: readonly ChecklistRunSummary[],
  fromEpoch: number,
  toEpoch: number,
): readonly ApparatusComplianceEntry[] {
  const expectedChecks = expectedChecksForRange(fromEpoch, toEpoch);
  const checkedDaysByApparatusId = new Map<string, Set<number>>();
  for (const run of runs) {
    const checkedDays = checkedDaysByApparatusId.get(run.apparatusId) ?? new Set<number>();
    checkedDays.add(dayIndexUtc(run.completedAt));
    checkedDaysByApparatusId.set(run.apparatusId, checkedDays);
  }
  return roster.map((apparatus) => {
    const actualChecks = checkedDaysByApparatusId.get(apparatus.apparatusId)?.size ?? 0;
    return {
      unitId: apparatus.unitId,
      expectedChecks,
      actualChecks,
      compliant: actualChecks >= expectedChecks,
    };
  });
}
