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
import { getNerisDeptSettings, nerisSettingsPk } from '../nerisSettings.js';
import { nerisApiFromEnv } from '../reportContext.js';
import type { NerisApi, NerisListedIncident } from './api.js';
import { scannerDeptIds } from './statusPoller.js';
import { toNerisIncidentNumber } from './payload.js';

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
  const localNumbers = new Set(local.map((record) => toNerisIncidentNumber(record.dispatchNumber)));
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
      if (record.incidentNumber && localNumbers.has(record.incidentNumber)) continue;
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

/** `YYYY-MM` of the month before `now` (UTC), with its [start, end) epoch-second bounds. */
export function previousMonth(now: Date): { month: string; from: number; to: number } {
  const startOfThis = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const startOfPrev = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return {
    month: new Date(startOfPrev).toISOString().slice(0, 7),
    from: startOfPrev / 1000,
    to: startOfThis / 1000 - 1,
  };
}

export async function remindNoActivity(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  now: Date,
  correlationId: string,
): Promise<'reminded' | 'not_needed'> {
  const { month, from, to } = previousMonth(now);
  const incidents = await queryIncidentsBetween(client, tableName, deptId, from, to);
  if (incidents.length > 0) return 'not_needed';
  const pk = nerisSettingsPk(deptId);
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
  const pk = nerisSettingsPk(deptId);
  const summary = {
    pk,
    sk: 'RECONCILIATION#LAST',
    entityType: 'NERIS_RECONCILIATION',
    ranAt: now.toISOString(),
    localCount: local.length,
    nerisCount: listed.incidents.length,
    truncated: listed.truncated,
    driftCount: drift.length,
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

export async function runReconciliation(
  correlationId: string,
  deps: ReconcileDeps = {},
): Promise<void> {
  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);
  const now = (deps.now ?? (() => new Date()))();
  for (const deptId of scannerDeptIds(process.env)) {
    try {
      const reminder = await remindNoActivity(client, tableName, deptId, now, correlationId);
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
    const settings = await getNerisDeptSettings(client, tableName, deptId);
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
