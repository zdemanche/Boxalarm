import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
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

/** Records checked per department per run; the rest wait five minutes. */
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

export async function pollRecord(
  client: DynamoDBDocumentClient,
  tableName: string,
  api: NerisApi,
  deptId: VerifiedDeptId,
  departmentNerisId: string,
  open: { readonly incidentId: string; readonly nerisIncidentId: string },
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

  const final = !OPEN_NERIS_STATUSES.has(current.status);
  const eventType = EVENT_FOR_STATUS[current.status];
  const localStatus =
    current.status === 'APPROVED'
      ? 'ACCEPTED'
      : current.status === 'REJECTED'
        ? 'REJECTED'
        : undefined;
  const pk = metadataKey.pk;
  const historyRows = result.history.slice(-40).map((entry) => ({
    Put: {
      TableName: tableName,
      Item: {
        pk,
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
            Key: metadataKey,
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
                    statusAt: current.lastModified,
                  }),
                },
              },
            ]
          : []),
      ],
    }),
  );
  return 'changed';
}

export interface PollerDeps {
  readonly client?: DynamoDBDocumentClient;
  readonly api?: NerisApi;
  readonly now?: () => number;
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
    const open = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'NERIS_OPEN') },
        Limit: MAX_RECORDS_PER_RUN,
      }),
    );
    const records = (open.Items ?? []).flatMap((item) =>
      typeof item.incidentId === 'string' && typeof item.nerisIncidentId === 'string'
        ? [{ incidentId: item.incidentId, nerisIncidentId: item.nerisIncidentId }]
        : [],
    );
    if (records.length === 0) {
      continue;
    }
    const api = deps.api ?? (await nerisApiFromEnv());
    const counts: Record<PollOutcome, number> = { unchanged: 0, changed: 0, failed: 0 };
    for (const record of records) {
      try {
        counts[
          await pollRecord(
            client,
            tableName,
            api,
            deptId,
            settings.departmentNerisId,
            record,
            now(),
          )
        ] += 1;
      } catch (error) {
        counts.failed += 1;
        logger.error({
          event: 'neris.poller.record_failed',
          correlationId,
          deptId,
          incidentId: record.incidentId,
          message: error instanceof Error ? error.message : undefined,
        });
      }
    }
    logger.info({ event: 'neris.poller.completed', correlationId, deptId, ...counts });
    if (counts.changed > 0) emitOutcomeMetric(METRIC_NAMESPACE, 'NerisStatusChanged');
    if (counts.failed > 0) emitOutcomeMetric(METRIC_NAMESPACE, 'NerisStatusPollFailed');
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runStatusPoll(event.id ?? 'scheduled');
};
