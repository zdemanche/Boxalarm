import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import {
  ApparatusRepositoryUnavailableError,
  logError,
  type ApparatusListItem,
} from './repository.js';

const SECONDS_PER_DAY = 86400;

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

function apparatusIdFromPartitionKey(partitionKey: string): string | undefined {
  const marker = '#APPARATUS#';
  const index = partitionKey.indexOf(marker);
  return index === -1 ? undefined : partitionKey.slice(index + marker.length);
}

function toChecklistRunSummary(item: Record<string, unknown>): ChecklistRunSummary | undefined {
  const partitionKey = item.pk;
  const completedAt = item.gsi3sk;
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
          ExpressionAttributeValues: {
            ':gsi3pk': buildDeptScopedPk(deptId, 'CHECKLIST_RUN'),
            ':from': fromEpoch,
            ':to': toEpoch,
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

function expectedChecksForRange(fromEpoch: number, toEpoch: number): number {
  return Math.floor((toEpoch - fromEpoch) / SECONDS_PER_DAY) + 1;
}

export function computeComplianceReport(
  roster: readonly ApparatusListItem[],
  runs: readonly ChecklistRunSummary[],
  fromEpoch: number,
  toEpoch: number,
): readonly ApparatusComplianceEntry[] {
  const expectedChecks = expectedChecksForRange(fromEpoch, toEpoch);
  const actualByUnitId = new Map<string, number>();
  for (const run of runs) {
    actualByUnitId.set(run.apparatusId, (actualByUnitId.get(run.apparatusId) ?? 0) + 1);
  }
  return roster.map((apparatus) => {
    const actualChecks = actualByUnitId.get(apparatus.unitId) ?? 0;
    return {
      unitId: apparatus.unitId,
      expectedChecks,
      actualChecks,
      compliant: actualChecks >= expectedChecks,
    };
  });
}
