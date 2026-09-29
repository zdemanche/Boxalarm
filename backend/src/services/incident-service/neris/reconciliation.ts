import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { createLogger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from '../repository.js';
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
 * Nightly NERIS reconciliation (EventBridge Scheduler, once a day).
 *
 * 1. Drift: every local report NERIS accepted is compared with GET /incident for the
 *    department. `MISSING_IN_NERIS` (deleted or superseded there), `STATUS_MISMATCH`
 *    (NERIS moved on and we did not see it) and `UNKNOWN_IN_NERIS` (a record NERIS holds for
 *    the department that Boxalarm never sent — another system, or a double entry) are
 *    published once as `neris.reconciliation.drift_detected` and kept on the department's
 *    last-run row. A truncated NERIS listing skips the two "missing" checks rather than
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
}

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
      if (!truncated) {
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
): Promise<{ drift: Drift[]; truncated: boolean } | undefined> {
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
  };
  if (drift.length === 0) {
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
  return { drift, truncated: listed.truncated };
}

/**
 * Drift is repaired, not only reported (review M7):
 *   - STATUS_MISMATCH: NERIS's status is applied locally exactly as the poller would — local
 *     status, history, the approved/rejected event the owner is told from — and a still-open
 *     record goes back on the poller's work list;
 *   - MISSING_IN_NERIS: the record goes back on the work list, so the poller re-checks it
 *     and, if NERIS really no longer has it, ages it out with a poll_expired event.
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
        repaired += 1;
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
        truncated: result.truncated,
      });
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        result.drift.length > 0 ? 'ReconciliationDriftDetected' : 'ReconciliationClean',
      );
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
