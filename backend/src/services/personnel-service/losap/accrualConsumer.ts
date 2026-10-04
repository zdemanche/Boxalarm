import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-losap-accrual';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'losap-accrual-consumer';

interface AttendanceRecordedEnvelope {
  readonly eventId: string;
  readonly deptId: string;
  readonly memberId: string;
  readonly activityType: string;
  readonly activityId: string;
  readonly losapPoints: number;
}

/**
 * The accrual queue is an EventBridge rule target with no inputPath, so each SQS body is the
 * whole EventBridge event and the outbox envelope sits under `detail`.
 */
function parseEnvelope(body: string): AttendanceRecordedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  if (typeof parsed.detail !== 'object' || parsed.detail === null) {
    throw new Error('personnel.attendance.recorded message is missing detail');
  }
  const raw = parsed.detail as Record<string, unknown>;
  const eventId = raw.eventId;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const memberId = payload?.memberId;
  const activityType = payload?.activityType;
  const activityId = payload?.activityId;
  const losapPoints = payload?.losapPoints;
  if (
    typeof eventId !== 'string' ||
    typeof deptId !== 'string' ||
    typeof memberId !== 'string' ||
    typeof activityType !== 'string' ||
    typeof activityId !== 'string' ||
    typeof losapPoints !== 'number'
  ) {
    throw new Error('personnel.attendance.recorded event failed shape validation');
  }
  return { eventId, deptId, memberId, activityType, activityId, losapPoints };
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
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

/**
 * #206: the LOSAP points award itself still happens inline, in the same transaction as the
 * attendance write (attendance/handler.ts, shifts/completeShiftAttendance.ts) — this
 * consumer does not re-award points, which would double-count them. It exists to give the
 * event-driven path its own idempotent processed-record (EVENT_DEDUP) ahead of a later
 * change that moves the award itself off the attendance write path.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAttendanceTableConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: AttendanceRecordedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('losapAccrual.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, memberId, activityType, activityId, losapPoints } = envelope;
    const deptId = toVerifiedDeptId({ deptId: envelope.deptId });

    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, memberId),
            sk: `EVT#${eventId}`,
            entityType: 'EVENT_DEDUP',
            activityType,
            activityId,
            losapPoints,
            ttl: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
        continue;
      }
      logError('losapAccrual.dedup_write_failed', error, eventId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'AccrualProcessingFailed');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'AccrualProcessed');
  }
};
