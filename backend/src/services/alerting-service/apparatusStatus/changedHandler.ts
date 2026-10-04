import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-apparatus-status';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'apparatus-status-changed-consumer';

interface ApparatusStatusChangedEnvelope {
  readonly eventId: string;
  readonly eventTime: number;
  readonly deptId: string;
  readonly unitId: string;
  readonly status: 'IN_SERVICE' | 'OUT_OF_SERVICE';
  readonly reason?: string;
}

/**
 * This queue is an EventBridge rule target with no inputPath, so each SQS body is the whole
 * EventBridge event and the outbox envelope sits under `detail` — the same contract every
 * other alerting-owned copy consumer parses (eligibility/consumer.ts, hydrantCopyHandler.ts).
 */
function parseEnvelope(body: string): ApparatusStatusChangedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  if (typeof parsed.detail !== 'object' || parsed.detail === null) {
    throw new Error('apparatus.serviceStatus.changed message is missing detail');
  }
  const raw = parsed.detail as Record<string, unknown>;
  const eventId = raw.eventId;
  const eventTimeRaw = raw.eventTime;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const unitId = payload?.unitId;
  const status = payload?.status;
  const reason = payload?.reason;
  const eventTime = typeof eventTimeRaw === 'string' ? Date.parse(eventTimeRaw) : NaN;
  if (
    typeof eventId !== 'string' ||
    !Number.isFinite(eventTime) ||
    typeof deptId !== 'string' ||
    typeof unitId !== 'string' ||
    (status !== 'IN_SERVICE' && status !== 'OUT_OF_SERVICE') ||
    (reason !== undefined && typeof reason !== 'string')
  ) {
    throw new Error('apparatus.serviceStatus.changed event failed shape validation');
  }
  return {
    eventId,
    eventTime,
    deptId,
    unitId,
    status,
    ...(reason !== undefined ? { reason } : {}),
  };
}

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

/**
 * #235: a read-only alerting-owned copy of each unit's in/out-of-service status, kept
 * dept-wide (not per-dispatch) so the dispatch-detail route can annotate a responding
 * apparatus without a platform-table grant (alerting-plane IAM boundary). Only the fields
 * this event carries are set, so a redelivery with the same eventId is a no-op.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: ApparatusStatusChangedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('apparatusStatus.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, eventTime, unitId, status, reason } = envelope;
    const deptId = toVerifiedDeptId({ deptId: envelope.deptId });

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, unitId),
                  sk: `EVT#${eventId}`,
                  entityType: 'EVENT_DEDUP',
                  ttl: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { pk: buildDeptScopedPk(deptId, 'APPARATUS_STATUS'), sk: `UNIT#${unitId}` },
                UpdateExpression:
                  'SET entityType = :entityType, unitId = :unitId, #status = :status, ' +
                  'statusUpdatedAt = :now' +
                  (reason !== undefined ? ', reason = :reason' : ' REMOVE reason'),
                ConditionExpression:
                  'attribute_not_exists(statusUpdatedAt) OR :now > statusUpdatedAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':entityType': 'APPARATUS_STATUS_COPY',
                  ':unitId': unitId,
                  ':status': status,
                  ':now': eventTime,
                  ...(reason !== undefined ? { ':reason': reason } : {}),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const cancellation = asTransactionCancellation(error);
      if (cancellation) {
        const reasons = cancellation.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
          continue;
        }
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          emitOutcomeMetric(METRIC_NAMESPACE, 'StaleEventSkipped');
          continue;
        }
      }
      logError('apparatusStatus.copy_update_failed', error, eventId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'CopyUpdateFailed');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'CopyUpdated');
  }
};
