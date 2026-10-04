import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { createLogger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName, isConditionFailureAt } from '../repository.js';
import { getNerisDeptSettings } from '../nerisSettings.js';
import { nerisApiFromEnv } from '../reportContext.js';
import type { NerisApi, NerisListedIncident } from './api.js';
import { applyStatusChange, scannerDeptIds } from './statusPoller.js';
import { nerisOpenKey } from '../submissionRepository.js';
import { isNerisIncidentStatus } from './paths.js';
import { DEFAULT_TIME_ZONE, previousMonthOf, zonedMonth, zonedMonthBounds } from './zonedTime.js';

const logger = createLogger({ service: 'incident-service' });
const METRIC_NAMESPACE = 'Boxalarm/neris-reconciliation';

/** How far back local records are compared (NERIS went live 2026-01-01). */
export const RECONCILE_WINDOW_DAYS = 400;
const MAX_DRIFT_IN_EVENT = 50;
/**
 * Nightly runs a record may be found missing from NERIS (and re-queued for the poller)
 * before it is given up on: marked `nerisMissingAt`, taken off the work list, and reported
 * once as `neris.incident.missing` (inbox for owner/locker/officers, and an alarm).
 */
export const MISSING_MAX_CHECKS = 3;

/**
 * Nightly NERIS reconciliation (EventBridge Scheduler, once a day).
 *
 * 1. Drift: every local report NERIS accepted is compared with GET /incident for the
 *    department. `MISSING_IN_NERIS` (deleted or superseded there), `STATUS_MISMATCH`
 *    (NERIS moved on and we did not see it) and `UNKNOWN_IN_NERIS` (a record NERIS holds for
 *    the department that Boxalarm never sent — another system, or a double entry) are
 *    kept on the department's last-run row; drift not seen on the previous run is published as
 *    `neris.reconciliation.drift_detected` and counted by the alarmed ReconciliationNewDrift. A truncated NERIS listing skips the two "missing" checks rather than
 *    guessing.
 * 2. No-activity months: when the previous month closed with zero local incidents and no
 *    no-activity report on file, `neris.no_activity.due` goes out once for that month so the
 *    chief is reminded to file it (POST /incidents/no-activity-reports).
 */

export type DriftKind = 'MISSING_IN_NERIS' | 'STATUS_MISMATCH' | 'UNKNOWN_IN_NERIS';

export interface Drift {
  readonly kind: DriftKind;
  readonly incidentId?: string;
  readonly nerisIncidentId: string;
  readonly localStatus?: string;
  readonly nerisStatus?: string;
}

export interface LocalSubmitted {
  readonly incidentId: string;
  readonly nerisIncidentId: string;
  readonly nerisStatus?: string;
  readonly dispatchNumber: string;
  /** Nights in a row this record was missing from NERIS (reset when it is seen again). */
  readonly missingChecks?: number;
  /**
   * Given up on as no longer in NERIS (`nerisMissingAt`): not reported missing again, and
   * if NERIS lists it again its marker is cleared rather than it showing as unknown drift.
   */
  readonly givenUp?: boolean;
}

/** One drift finding's identity across nights: new drift is what the alarm pages on. */
export function driftKey(entry: Drift): string {
  // A status mismatch that changes (NERIS moved again, or we did) is new drift (round 2c, Q2).
  return entry.kind === 'STATUS_MISMATCH'
    ? `${entry.kind}#${entry.nerisIncidentId}#${entry.localStatus ?? ''}>${entry.nerisStatus ?? ''}`
    : `${entry.kind}#${entry.nerisIncidentId}`;
}

/** Drift keys kept on the last-run row to tell new drift from drift already reported. */
const MAX_DRIFT_KEYS = 1_000;

export function diffAgainstNeris(
  local: readonly LocalSubmitted[],
  remote: readonly NerisListedIncident[],
  truncated: boolean,
): Drift[] {
  const drift: Drift[] = [];
  const remoteById = new Map(remote.map((record) => [record.nerisId, record]));
  const localIds = new Set(local.map((record) => record.nerisIncidentId));
  for (const record of local) {
    const found = remoteById.get(record.nerisIncidentId);
    if (!found) {
      if (!truncated && !record.givenUp) {
        drift.push({
          kind: 'MISSING_IN_NERIS',
          incidentId: record.incidentId,
          nerisIncidentId: record.nerisIncidentId,
          ...(record.nerisStatus ? { localStatus: record.nerisStatus } : {}),
        });
      }
      continue;
    }
    if (found.status && record.nerisStatus && found.status !== record.nerisStatus) {
      drift.push({
        kind: 'STATUS_MISMATCH',
        incidentId: record.incidentId,
        nerisIncidentId: record.nerisIncidentId,
        localStatus: record.nerisStatus,
        nerisStatus: found.status,
      });
    }
  }
  if (!truncated) {
    for (const record of remote) {
      if (localIds.has(record.nerisId)) continue;
      // No skip by incident number: a second NERIS record with the same number but another
      // call_create is exactly the duplicate this check exists to find (review minor 10).
      drift.push({
        kind: 'UNKNOWN_IN_NERIS',
        nerisIncidentId: record.nerisId,
        ...(record.status ? { nerisStatus: record.status } : {}),
      });
    }
  }
  return drift;
}

async function queryIncidentsBetween(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  fromAlarmAt: number,
  toAlarmAt: number,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId),
          ':from': `INCIDENT#${fromAlarmAt}`,
          ':to': `INCIDENT#${toAlarmAt}`,
        },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return items;
}

/** The department-local month before `now`, with its inclusive epoch-second bounds. */
export function previousMonth(
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): { month: string; from: number; to: number } {
  const month = previousMonthOf(zonedMonth(now.getTime(), timeZone));
  return { month, ...zonedMonthBounds(month, timeZone) };
}

export async function remindNoActivity(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  now: Date,
  correlationId: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<'reminded' | 'not_needed'> {
  const { month, from, to } = previousMonth(now, timeZone);
  const incidents = await queryIncidentsBetween(client, tableName, deptId, from, to);
  if (incidents.length > 0) return 'not_needed';
  const pk = buildDeptScopedPk(deptId, 'NERIS');
  const filed = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: `NO_ACTIVITY#${month}` } }),
  );
  if (filed.Item) return 'not_needed';
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `NO_ACTIVITY_REMINDER#${month}`,
                entityType: 'NERIS_NO_ACTIVITY_REMINDER',
                month,
                remindedAt: now.toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                deptId,
                'incident-service',
                'neris.no_activity.due',
                correlationId,
                {
                  deptId,
                  month,
                },
              ),
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      return 'not_needed';
    }
    throw error;
  }
  return 'reminded';
}

export interface ReconcileDeps {
  readonly client?: DynamoDBDocumentClient;
  readonly api?: NerisApi;
  readonly now?: () => Date;
}

export async function reconcileDepartment(
  client: DynamoDBDocumentClient,
  tableName: string,
  api: NerisApi,
  deptId: VerifiedDeptId,
  departmentNerisId: string,
  now: Date,
  correlationId: string,
): Promise<{ drift: Drift[]; truncated: boolean; newDriftCount: number } | undefined> {
  const toAlarmAt = Math.floor(now.getTime() / 1000);
  const local = (
    await queryIncidentsBetween(
      client,
      tableName,
      deptId,
      toAlarmAt - RECONCILE_WINDOW_DAYS * 86_400,
      toAlarmAt,
    )
  ).flatMap((item) =>
    typeof item.incidentId === 'string' && typeof item.nerisIncidentId === 'string'
      ? [
          {
            incidentId: item.incidentId,
            nerisIncidentId: item.nerisIncidentId,
            dispatchNumber: typeof item.dispatchNumber === 'string' ? item.dispatchNumber : '',
            ...(typeof item.nerisStatus === 'string' ? { nerisStatus: item.nerisStatus } : {}),
            ...(typeof item.nerisMissingChecks === 'number'
              ? { missingChecks: item.nerisMissingChecks }
              : {}),
            ...(item.nerisMissingAt !== undefined ? { givenUp: true } : {}),
          },
        ]
      : [],
  );
  const listed = await api.listIncidents(departmentNerisId);
  if (!listed.ok) {
    logger.warn({
      event: 'neris.reconciliation.list_failed',
      correlationId,
      deptId,
      httpStatus: listed.httpStatus,
    });
    return undefined;
  }
  const drift = diffAgainstNeris(local, listed.incidents, listed.truncated);
  const repaired = await repairDrift(client, tableName, deptId, drift, listed.incidents, now);
  await clearFoundAgain(client, tableName, deptId, local, listed.incidents);
  // Drift already reported on an earlier night is not new: the alarm and the event are for
  // what changed, so a persisting difference does not page the chief every night (R4).
  const previous = (
    await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'NERIS'), sk: 'RECONCILIATION#LAST' },
      }),
    )
  ).Item as { driftKeys?: unknown } | undefined;
  const seen = new Set(Array.isArray(previous?.driftKeys) ? (previous.driftKeys as string[]) : []);
  const newDrift = drift.filter((entry) => !seen.has(driftKey(entry)));
  const pk = buildDeptScopedPk(deptId, 'NERIS');
  const summary = {
    pk,
    sk: 'RECONCILIATION#LAST',
    entityType: 'NERIS_RECONCILIATION',
    ranAt: now.toISOString(),
    localCount: local.length,
    nerisCount: listed.incidents.length,
    truncated: listed.truncated,
    driftCount: drift.length,
    repairedCount: repaired,
    drift: drift.slice(0, MAX_DRIFT_IN_EVENT),
    newDriftCount: newDrift.length,
    driftKeys: drift.map(driftKey).slice(0, MAX_DRIFT_KEYS),
  };
  if (newDrift.length === 0) {
    await client.send(new PutCommand({ TableName: tableName, Item: summary }));
  } else {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: summary } },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                deptId,
                'incident-service',
                'neris.reconciliation.drift_detected',
                correlationId,
                {
                  deptId,
                  driftCount: drift.length,
                  newDriftCount: newDrift.length,
                  newDrift: newDrift.slice(0, MAX_DRIFT_IN_EVENT),
                  counts: {
                    MISSING_IN_NERIS: drift.filter((d) => d.kind === 'MISSING_IN_NERIS').length,
                    STATUS_MISMATCH: drift.filter((d) => d.kind === 'STATUS_MISMATCH').length,
                    UNKNOWN_IN_NERIS: drift.filter((d) => d.kind === 'UNKNOWN_IN_NERIS').length,
                  },
                  drift: drift.slice(0, MAX_DRIFT_IN_EVENT),
                },
              ),
            },
          },
        ],
      }),
    );
  }
  return { drift, truncated: listed.truncated, newDriftCount: newDrift.length };
}

/**
 * A record counted missing that NERIS lists again starts its count over; one given up on
 * (`nerisMissingAt`) is no longer missing at all (round 2b, R4).
 */
async function clearFoundAgain(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  local: readonly LocalSubmitted[],
  remote: readonly NerisListedIncident[],
): Promise<void> {
  const remoteIds = new Set(remote.map((record) => record.nerisId));
  for (const record of local) {
    if ((!record.missingChecks && !record.givenUp) || !remoteIds.has(record.nerisIncidentId)) {
      continue;
    }
    await client
      .send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', record.incidentId), sk: 'METADATA' },
          ConditionExpression: 'attribute_exists(pk) AND nerisIncidentId = :nerisId',
          UpdateExpression: 'REMOVE nerisMissingChecks, nerisMissingSince, nerisMissingAt',
          ExpressionAttributeValues: { ':nerisId': record.nerisIncidentId },
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
        throw error;
      });
  }
}

/**
 * MISSING_IN_NERIS, bounded (round 2, N6): counts the night on the report; before
 * MISSING_MAX_CHECKS the record goes back on the poller's work list, at the limit it is
 * given up on — `nerisMissingAt` set (terminal: no more re-queues or nightly drift), work
 * row deleted, and `neris.incident.missing` published for the owner, locker and officers.
 */
async function repairMissing(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  entry: Drift & { readonly incidentId: string },
  nowSeconds: number,
): Promise<'requeued' | 'expired' | 'skipped'> {
  const metadataKey = {
    pk: buildDeptScopedPk(deptId, 'INCIDENT', entry.incidentId),
    sk: 'METADATA',
  };
  let metadata: Record<string, unknown>;
  try {
    metadata = ((
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: metadataKey,
          ConditionExpression:
            'attribute_exists(pk) AND nerisIncidentId = :nerisId AND attribute_not_exists(nerisMissingAt)',
          UpdateExpression:
            'SET nerisMissingChecks = if_not_exists(nerisMissingChecks, :zero) + :one, nerisMissingSince = if_not_exists(nerisMissingSince, :now)',
          ExpressionAttributeValues: {
            ':nerisId': entry.nerisIncidentId,
            ':zero': 0,
            ':one': 1,
            ':now': nowSeconds,
          },
          ReturnValues: 'ALL_NEW',
        }),
      )
    ).Attributes ?? {}) as Record<string, unknown>;
  } catch (error) {
    // Resubmitted under another id, or already given up on: nothing to do.
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return 'skipped';
    }
    throw error;
  }
  const checks = typeof metadata.nerisMissingChecks === 'number' ? metadata.nerisMissingChecks : 1;
  if (checks < MISSING_MAX_CHECKS) {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...nerisOpenKey(deptId, entry.incidentId),
          entityType: 'NERIS_OPEN_SUBMISSION',
          incidentId: entry.incidentId,
          nerisIncidentId: entry.nerisIncidentId,
          since: nowSeconds,
          nextPollAt: nowSeconds,
          failures: 0,
        },
      }),
    );
    return 'requeued';
  }
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: metadataKey,
              ConditionExpression:
                'attribute_exists(pk) AND nerisIncidentId = :nerisId AND attribute_not_exists(nerisMissingAt)',
              UpdateExpression: 'SET nerisMissingAt = :now',
              ExpressionAttributeValues: { ':nerisId': entry.nerisIncidentId, ':now': nowSeconds },
            },
          },
          { Delete: { TableName: tableName, Key: nerisOpenKey(deptId, entry.incidentId) } },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                deptId,
                'incident-service',
                'neris.incident.missing',
                entry.incidentId,
                {
                  incidentId: entry.incidentId,
                  deptId,
                  nerisIncidentId: entry.nerisIncidentId,
                  incidentNumber:
                    typeof metadata.dispatchNumber === 'string'
                      ? metadata.dispatchNumber
                      : entry.incidentId,
                  ownerId: typeof metadata.createdBy === 'string' ? metadata.createdBy : null,
                  lockedBy: typeof metadata.lockedBy === 'string' ? metadata.lockedBy : null,
                  missingSince:
                    typeof metadata.nerisMissingSince === 'number'
                      ? metadata.nerisMissingSince
                      : nowSeconds,
                  checks,
                  reason: `NERIS has not listed this record for ${checks} nightly checks`,
                  statusAt: new Date(nowSeconds * 1000).toISOString(),
                },
              ),
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailureAt(error, 0)) return 'skipped';
    throw error;
  }
  emitOutcomeMetric(METRIC_NAMESPACE, 'NerisRecordMissing');
  return 'expired';
}

/**
 * Drift is repaired, not only reported (review M7):
 *   - STATUS_MISMATCH: NERIS's status is applied locally exactly as the poller would — local
 *     status, history, the approved/rejected event the owner is told from — and a still-open
 *     record goes back on the poller's work list;
 *   - MISSING_IN_NERIS: the record goes back on the work list, so the poller re-checks it,
 *     for at most MISSING_MAX_CHECKS nights; then it is given up on and reported
 *     (repairMissing).
 * Returns how many records were repaired.
 */
export async function repairDrift(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  drift: readonly Drift[],
  remote: readonly NerisListedIncident[],
  now: Date,
): Promise<number> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let repaired = 0;
  for (const entry of drift) {
    if (!entry.incidentId) continue;
    const open = { incidentId: entry.incidentId, nerisIncidentId: entry.nerisIncidentId };
    try {
      if (entry.kind === 'STATUS_MISMATCH' && isNerisIncidentStatus(entry.nerisStatus)) {
        const metadata = (
          await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', entry.incidentId), sk: 'METADATA' },
            }),
          )
        ).Item as Record<string, unknown> | undefined;
        if (!metadata) continue;
        const listed = remote.find((r) => r.nerisId === entry.nerisIncidentId);
        const current = {
          status: entry.nerisStatus,
          current: true,
          lastModified: listed?.lastModified ?? now.toISOString(),
        };
        await applyStatusChange(
          client,
          tableName,
          deptId,
          open,
          current,
          [current],
          metadata,
          nowSeconds,
          {
            requeue: true,
          },
        );
        repaired += 1;
      } else if (entry.kind === 'MISSING_IN_NERIS') {
        const result = await repairMissing(
          client,
          tableName,
          deptId,
          { ...entry, incidentId: entry.incidentId },
          nowSeconds,
        );
        if (result !== 'skipped') repaired += 1;
      }
    } catch (error) {
      logger.error({
        event: 'neris.reconciliation.repair_failed',
        correlationId: entry.incidentId,
        deptId,
        incidentId: entry.incidentId,
        kind: entry.kind,
        message: error instanceof Error ? error.message : undefined,
      });
    }
  }
  return repaired;
}

export async function runReconciliation(
  correlationId: string,
  deps: ReconcileDeps = {},
): Promise<void> {
  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);
  const now = (deps.now ?? (() => new Date()))();
  for (const deptId of scannerDeptIds(process.env)) {
    const settings = await getNerisDeptSettings(client, tableName, deptId);
    try {
      const reminder = await remindNoActivity(
        client,
        tableName,
        deptId,
        now,
        correlationId,
        settings.timeZone,
      );
      if (reminder === 'reminded') emitOutcomeMetric(METRIC_NAMESPACE, 'NoActivityReminderSent');
    } catch (error) {
      logger.error({
        event: 'neris.reconciliation.no_activity_failed',
        correlationId,
        deptId,
        message: error instanceof Error ? error.message : undefined,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'NoActivityReminderFailed');
    }
    if (!settings.departmentNerisId || !settings.submissionsEnabled) continue;
    try {
      const api = deps.api ?? (await nerisApiFromEnv());
      const result = await reconcileDepartment(
        client,
        tableName,
        api,
        deptId,
        settings.departmentNerisId,
        now,
        correlationId,
      );
      if (!result) {
        emitOutcomeMetric(METRIC_NAMESPACE, 'ReconciliationListFailed');
        continue;
      }
      logger.info({
        event: 'neris.reconciliation.completed',
        correlationId,
        deptId,
        driftCount: result.drift.length,
        newDriftCount: result.newDriftCount,
        truncated: result.truncated,
      });
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        result.drift.length > 0 ? 'ReconciliationDriftDetected' : 'ReconciliationClean',
      );
      // The alarmed metric: only drift not already reported on an earlier night.
      if (result.newDriftCount > 0) {
        emitOutcomeMetric(METRIC_NAMESPACE, 'ReconciliationNewDrift');
      }
    } catch (error) {
      logger.error({
        event: 'neris.reconciliation.failed',
        correlationId,
        deptId,
        message: error instanceof Error ? error.message : undefined,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'ReconciliationFailed');
    }
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runReconciliation(event.id ?? 'scheduled');
};
