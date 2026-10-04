import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../dynamoClient.js';
import { queryEligiblePartition } from '../selector.js';

/**
 * #232 (E1-S13): this handler used to measure each member's OWN absolute snapshot-write age
 * (`now - item.snapshotUpdatedAt`), so one member nobody had touched in 15+ minutes read as
 * "stale" even seconds after every other member's snapshot had just been applied — a false
 * positive baked into the metric itself, which is why infra (staleness.ts) never routed
 * `SnapshotStale` to the page topic. The fix measures PROPAGATION LAG instead: how long it
 * has been since the most recently applied eligibility write landed anywhere in the
 * department (`now - max(snapshotUpdatedAt)` across the partition). An idle-but-correct
 * member can no longer trip this; only a department-wide gap in applying snapshot updates
 * does. `SnapshotStale` is kept as a 0/1 department-wide flag (not a per-member count) so
 * the existing `SnapshotStale > 0` threshold alarm keeps working unchanged.
 *
 * Namespace also corrected from the old lowercase `Boxalarm/alerting-eligibility` to
 * `Boxalarm/AlertingEligibility`, matching memberUpdatedHandler.ts's
 * SnapshotPropagationLatencyMs — the two handlers wrote the same eligibility-snapshot data
 * path to two different CloudWatch namespaces before this fix. infra's staleness.ts alarm
 * is updated to the new namespace in the same changeset, and its `alarmActions` is restored
 * now that the metric can no longer alarm permanently.
 */
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
  /** 0 or 1: whether the department-wide propagation watermark is past the threshold. */
  readonly staleCount: number;
  readonly totalCount: number;
  /** Milliseconds since the most recently applied eligibility snapshot write; 0 if empty. */
  readonly propagationLagMs: number;
}

export const handler = async (): Promise<StalenessCheckResult> => {
  const { deptId: rawDeptId } = readStalenessConfig(process.env);
  const deptId = toVerifiedDeptId({ deptId: rawDeptId });
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  let items;
  try {
    items = await queryEligiblePartition(ddb, tableName, deptId);
  } catch (error) {
    logError('eligibility.staleness_check_failed', error);
    throw error;
  }

  const now = Date.now();
  const lastAppliedAt = items.reduce((latest, item) => Math.max(latest, item.snapshotUpdatedAt), 0);
  const propagationLagMs = items.length === 0 ? 0 : Math.max(now - lastAppliedAt, 0);
  const isStale = items.length > 0 && propagationLagMs > STALENESS_THRESHOLD_MILLISECONDS;
  const staleCount = isStale ? 1 : 0;

  emitEmf(METRIC_NAMESPACE, 'SnapshotStale', staleCount, [[]], {});
  emitEmf(METRIC_NAMESPACE, 'SnapshotPropagationLagMs', propagationLagMs, [[]], {}, 'Milliseconds');

  return { staleCount, totalCount: items.length, propagationLagMs };
};
