import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { createLogger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from '../repository.js';
import { getNerisDeptSettings } from '../nerisSettings.js';
import { nerisOpenKey } from '../submissionRepository.js';
import { OPEN_NERIS_STATUSES, type NerisIncidentStatus } from './paths.js';
import type { NerisApi, NerisHistoryEntry } from './api.js';
import { nerisApiFromEnv } from '../reportContext.js';

const logger = createLogger({ service: 'incident-service' });
const METRIC_NAMESPACE = 'Boxalarm/neris-status-poller';

/** Records polled per department per run; the cursor carries on from there next run. */
export const MAX_RECORDS_PER_RUN = 200;

/**
 * NERIS status poller — EventBridge Scheduler, every 5 minutes.
 *
 * For every record NERIS still has in SUBMITTED / PENDING_INCIDENT_DATA / PENDING_APPROVAL
 * (the DEPT#…#NERIS_OPEN work list the submission worker maintains) it reads
 * GET /incident/{dept}/{neris id}/history and, when the current status moved:
 *   - stores the new status and each history entry (NERIS#STATUS# rows, the ledger's
 *     status history);
 *   - emits neris.incident.approved | rejected | failed | deleted through the outbox, with
 *     the report owner so notification-service can tell them;
 *   - drops the record from the work list once the status is final.
 * One failing record never stops the others.
 */

export function scannerDeptIds(env: NodeJS.ProcessEnv): VerifiedDeptId[] {
  const raw = env.NERIS_SCANNER_DEPT_ID;
  if (!raw) {
    throw new Error('NERIS_SCANNER_DEPT_ID is required and was not set');
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((deptId) => toVerifiedDeptId({ deptId }));
}

const EVENT_FOR_STATUS: Partial<Record<NerisIncidentStatus, string>> = {
  APPROVED: 'neris.incident.approved',
  REJECTED: 'neris.incident.rejected',
  FAILED: 'neris.incident.failed',
  DELETED: 'neris.incident.deleted',
};

export function currentStatus(
  history: readonly NerisHistoryEntry[],
): NerisHistoryEntry | undefined {
  return history.find((entry) => entry.current) ?? history[history.length - 1];
}

export type PollOutcome = 'unchanged' | 'changed' | 'failed';

export interface OpenRecord {
  readonly incidentId: string;
  readonly nerisIncidentId: string;
}

/**
 * Applies a NERIS status the poller or the reconciliation observed: stores it (and the
 * history rows), maps APPROVED/REJECTED onto the local status, emits the outbox event the
 * owner is notified from, and keeps the work list right — deleted when final, (re)queued
 * when still open and `requeue` is set (reconciliation found it drifted).
 */
export async function applyStatusChange(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  open: OpenRecord,
  current: NerisHistoryEntry,
  history: readonly NerisHistoryEntry[],
  metadata: Record<string, unknown>,
  nowEpochSeconds: number,
  options: { readonly requeue?: boolean } = {},
): Promise<void> {
  const final = !OPEN_NERIS_STATUSES.has(current.status);
  const eventType = EVENT_FOR_STATUS[current.status];
  const localStatus =
    current.status === 'APPROVED'
      ? 'ACCEPTED'
      : current.status === 'REJECTED'
        ? 'REJECTED'
        : undefined;
  const historyRows = history.slice(-40).map((entry) => ({
    Put: {
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'INCIDENT', open.incidentId),
        sk: `NERIS#STATUS#${entry.lastModified}#${entry.status}`,
        entityType: 'NERIS_STATUS_HISTORY',
        status: entry.status,
        at: entry.lastModified,
        current: entry === current,
      },
    },
  }));
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', open.incidentId), sk: 'METADATA' },
            ConditionExpression: 'attribute_exists(pk)',
            UpdateExpression: `SET nerisStatus = :status, nerisStatusAt = :now${localStatus ? ', #status = :local' : ''}`,
            ...(localStatus ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
            ExpressionAttributeValues: {
              ':status': current.status,
              ':now': nowEpochSeconds,
              ...(localStatus ? { ':local': localStatus } : {}),
            },
          },
        },
        ...historyRows,
        ...(final
          ? [{ Delete: { TableName: tableName, Key: nerisOpenKey(deptId, open.incidentId) } }]
          : options.requeue
            ? [
                {
                  Put: {
                    TableName: tableName,
                    Item: {
                      ...nerisOpenKey(deptId, open.incidentId),
                      entityType: 'NERIS_OPEN_SUBMISSION',
                      incidentId: open.incidentId,
                      nerisIncidentId: open.nerisIncidentId,
                      since: nowEpochSeconds,
                      nextPollAt: nowEpochSeconds,
                      failures: 0,
                    },
                  },
                },
              ]
            : []),
        ...(eventType
          ? [
              {
                Put: {
                  TableName: tableName,
                  Item: buildOutboxRecord(deptId, 'incident-service', eventType, open.incidentId, {
                    incidentId: open.incidentId,
                    deptId,
                    nerisIncidentId: open.nerisIncidentId,
                    nerisStatus: current.status,
                    previousNerisStatus:
                      typeof metadata.nerisStatus === 'string' ? metadata.nerisStatus : null,
                    incidentNumber:
                      typeof metadata.dispatchNumber === 'string'
                        ? metadata.dispatchNumber
                        : open.incidentId,
                    ownerId: typeof metadata.createdBy === 'string' ? metadata.createdBy : null,
                    lockedBy: typeof metadata.lockedBy === 'string' ? metadata.lockedBy : null,
                    statusAt: current.lastModified,
                  }),
                },
              },
            ]
          : []),
      ],
    }),
  );
}

export async function pollRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  api: NerisApi,
  deptId: VerifiedDeptId,
  departmentNerisId: string,
  open: OpenRecord,
  nowEpochSeconds: number,
): Promise<PollOutcome> {
  const result = await api.getIncidentHistory(departmentNerisId, open.nerisIncidentId);
  if (!result.ok) {
    logger.warn({
      event: 'neris.poller.history_failed',
      correlationId: open.incidentId,
      deptId,
      httpStatus: result.httpStatus,
      kind: result.kind,
    });
    return 'failed';
  }
  const current = currentStatus(result.history);
  if (!current) {
    return 'unchanged';
  }
  const metadataKey = {
    pk: buildDeptScopedPk(deptId, 'INCIDENT', open.incidentId),
    sk: 'METADATA',
  };
  const metadata = (await client.send(new GetCommand({ TableName: tableName, Key: metadataKey })))
    .Item as Record<string, unknown> | undefined;
  if (!metadata) {
    await client.send(
      new DeleteCommand({ TableName: tableName, Key: nerisOpenKey(deptId, open.incidentId) }),
    );
    return 'unchanged';
  }
  if (metadata.nerisStatus === current.status) {
    return 'unchanged';
  }
  await applyStatusChange(
    client,
    tableName,
    deptId,
    open,
    current,
    result.history,
    metadata,
    nowEpochSeconds,
  );
  return 'changed';
}

/**
 * How long until a still-open record is polled again: often while NERIS is likely to move
 * it, then less and less (a state with no approver can leave records pending for weeks).
 */
export function pollInterval(ageSeconds: number): number {
  if (ageSeconds < 3_600) return 300;
  if (ageSeconds < 86_400) return 900;
  if (ageSeconds < 7 * 86_400) return 3_600;
  return 6 * 3_600;
}

/** Past this age, or this many consecutive failed polls, a record leaves the work list. */
export const POLL_MAX_AGE_SECONDS = 60 * 86_400;
export const POLL_MAX_FAILURES = 12;
/** Work-list pages read per department per run (budget guard). */
const MAX_PAGES_PER_RUN = 10;

interface WorkRow extends OpenRecord {
  readonly since: number;
  readonly nextPollAt: number;
  readonly failures: number;
}

function toWorkRow(item: Record<string, unknown>, now: number): WorkRow | undefined {
  if (typeof item.incidentId !== 'string' || typeof item.nerisIncidentId !== 'string') {
    return undefined;
  }
  return {
    incidentId: item.incidentId,
    nerisIncidentId: item.nerisIncidentId,
    since: typeof item.since === 'number' ? item.since : now,
    nextPollAt: typeof item.nextPollAt === 'number' ? item.nextPollAt : 0,
    failures: typeof item.failures === 'number' ? item.failures : 0,
  };
}

const CURSOR_SK = 'POLLER#CURSOR';

async function reschedule(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  row: WorkRow,
  outcome: PollOutcome,
  now: number,
  correlationId: string,
): Promise<'kept' | 'expired'> {
  const failures = outcome === 'failed' ? row.failures + 1 : 0;
  const age = now - row.since;
  if (age > POLL_MAX_AGE_SECONDS || failures >= POLL_MAX_FAILURES) {
    // Aged out: stop spending calls; the nightly reconciliation still compares it, and the
    // event records why it stopped being watched.
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: tableName, Key: nerisOpenKey(deptId, row.incidentId) } },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                deptId,
                'incident-service',
                'neris.incident.poll_expired',
                correlationId,
                {
                  incidentId: row.incidentId,
                  deptId,
                  nerisIncidentId: row.nerisIncidentId,
                  reason: failures >= POLL_MAX_FAILURES ? 'POLL_FAILURES' : 'MAX_AGE',
                  failures,
                  ageSeconds: age,
                },
              ),
            },
          },
        ],
      }),
    );
    return 'expired';
  }
  const base = pollInterval(age);
  const delay = outcome === 'failed' ? Math.min(base * 2 ** failures, 6 * 3_600) : base;
  await client
    .send(
      new UpdateCommand({
        TableName: tableName,
        Key: nerisOpenKey(deptId, row.incidentId),
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: 'SET nextPollAt = :next, failures = :failures',
        ExpressionAttributeValues: { ':next': now + delay, ':failures': failures },
      }),
    )
    .catch((error: unknown) => {
      // The record went final (and left the list) during this run: nothing to reschedule.
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
      throw error;
    });
  return 'kept';
}

export interface PollerDeps {
  readonly client?: DynamoDBDocumentClient;
  readonly api?: NerisApi;
  readonly now?: () => number;
}

/**
 * One department's run: continue the work list from the persisted cursor (wrapping at the
 * end), poll up to MAX_RECORDS_PER_RUN records that are due, reschedule each by age and
 * failures, age out the hopeless ones. Every record is reached in turn however long the
 * list grows (review M7).
 */
async function pollDepartment(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  departmentNerisId: string,
  getApi: () => Promise<NerisApi>,
  now: () => number,
  correlationId: string,
): Promise<Record<PollOutcome | 'expired', number>> {
  const counts = { unchanged: 0, changed: 0, failed: 0, expired: 0 };
  const cursorKey = { pk: buildDeptScopedPk(deptId, 'NERIS'), sk: CURSOR_SK };
  const cursor = (await client.send(new GetCommand({ TableName: tableName, Key: cursorKey })))
    .Item as { lastIncidentId?: unknown } | undefined;
  let startKey: Record<string, unknown> | undefined =
    typeof cursor?.lastIncidentId === 'string'
      ? nerisOpenKey(deptId, cursor.lastIncidentId)
      : undefined;
  let lastSeen: string | undefined;
  let budget = MAX_RECORDS_PER_RUN;
  let api: NerisApi | undefined;
  let reachedEnd = false;

  for (let page = 0; page < MAX_PAGES_PER_RUN && budget > 0; page++) {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'NERIS_OPEN') },
        Limit: MAX_RECORDS_PER_RUN,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (result.Items ?? []) as Record<string, unknown>[]) {
      if (budget <= 0) break;
      const row = toWorkRow(item, now());
      if (!row) continue;
      lastSeen = row.incidentId;
      if (row.nextPollAt > now()) continue;
      budget -= 1;
      let outcome: PollOutcome;
      try {
        api ??= await getApi();
        outcome = await pollRecord(client, tableName, api, deptId, departmentNerisId, row, now());
      } catch (error) {
        outcome = 'failed';
        logger.error({
          event: 'neris.poller.record_failed',
          correlationId,
          deptId,
          incidentId: row.incidentId,
          message: error instanceof Error ? error.message : undefined,
        });
      }
      counts[outcome] += 1;
      if (
        (await reschedule(client, tableName, deptId, row, outcome, now(), correlationId)) ===
        'expired'
      ) {
        counts.expired += 1;
      }
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) {
      reachedEnd = true;
      break;
    }
  }

  // Next run continues after the last row read; at the end of the list it starts over.
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...cursorKey,
        entityType: 'NERIS_POLLER_CURSOR',
        ...(reachedEnd || !lastSeen ? {} : { lastIncidentId: lastSeen }),
        updatedAt: now(),
      },
    }),
  );
  return counts;
}

export async function runStatusPoll(correlationId: string, deps: PollerDeps = {}): Promise<void> {
  const client = deps.client ?? getDocumentClient();
  const tableName = getTableName(process.env);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  for (const deptId of scannerDeptIds(process.env)) {
    const settings = await getNerisDeptSettings(client, tableName, deptId);
    if (!settings.departmentNerisId) {
      continue;
    }
    const counts = await pollDepartment(
      client,
      tableName,
      deptId,
      settings.departmentNerisId,
      () => (deps.api ? Promise.resolve(deps.api) : nerisApiFromEnv()),
      now,
      correlationId,
    );
    logger.info({ event: 'neris.poller.completed', correlationId, deptId, ...counts });
    if (counts.changed > 0) emitOutcomeMetric(METRIC_NAMESPACE, 'NerisStatusChanged');
    if (counts.failed > 0) emitOutcomeMetric(METRIC_NAMESPACE, 'NerisStatusPollFailed');
    if (counts.expired > 0) emitOutcomeMetric(METRIC_NAMESPACE, 'NerisStatusPollExpired');
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runStatusPoll(event.id ?? 'scheduled');
};
