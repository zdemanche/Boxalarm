import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';
import { createDdbClient, readAlertingDdbConfig } from '../dynamoClient.js';
import { queryEligiblePartition } from '../selector.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingEligibility';
const STALENESS_THRESHOLD_SECONDS = 15 * 60;
const STALENESS_THRESHOLD_MILLISECONDS = STALENESS_THRESHOLD_SECONDS * 1000;

function readStalenessConfig(env: NodeJS.ProcessEnv): { readonly deptId: string } {
  const deptId = env.DEPT_ID;
  if (!deptId) {
    throw new Error('DEPT_ID is required and was not set');
  }
  return { deptId };
}

function logError(event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

export interface StalenessCheckResult {
  readonly staleCount: number;
  readonly totalCount: number;
}

export const handler = async (): Promise<StalenessCheckResult> => {
  const { deptId: rawDeptId } = readStalenessConfig(process.env);
  const deptId = toVerifiedDeptId({ deptId: rawDeptId });
  const { tableName } = readAlertingDdbConfig(process.env);
  const ddb = createDdbClient(process.env);

  let items;
  try {
    items = await queryEligiblePartition(ddb, tableName, deptId);
  } catch (error) {
    logError('eligibility.staleness_check_failed', error);
    throw error;
  }

  const now = Date.now();
  const staleCount = items.filter(
    (item) => now - item.snapshotUpdatedAt > STALENESS_THRESHOLD_MILLISECONDS,
  ).length;

  emitEmf(METRIC_NAMESPACE, 'SnapshotStale', staleCount, [[]], {});

  return { staleCount, totalCount: items.length };
};
