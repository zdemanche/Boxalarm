import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingPrePlan';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'preplan-copy-consumer';

interface UtilityShutoff {
  readonly utility: string;
  readonly location: string;
}

interface PrePlanUpdatedPayload {
  readonly deptId: string;
  readonly occupancyId: string;
  readonly summary?: string;
  readonly hazards?: readonly string[];
  readonly utilityShutoffs?: readonly UtilityShutoff[];
}

interface PrePlanUpdatedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly payload: PrePlanUpdatedPayload;
}

function parseEnvelope(body: string): PrePlanUpdatedEnvelope {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const eventId = raw.eventId;
  const eventTime = raw.eventTime;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const occupancyId = payload?.occupancyId;
  if (
    typeof eventId !== 'string' ||
    typeof eventTime !== 'string' ||
    !Number.isFinite(Date.parse(eventTime)) ||
    typeof deptId !== 'string' ||
    typeof occupancyId !== 'string'
  ) {
    throw new Error('inspections.preplan.updated event failed shape validation');
  }
  const hazards = Array.isArray(payload?.hazards) ? (payload.hazards as string[]) : undefined;
  const utilityShutoffs = Array.isArray(payload?.utilityShutoffs)
    ? (payload.utilityShutoffs as UtilityShutoff[])
    : undefined;
  const summary = typeof payload?.summary === 'string' ? payload.summary : undefined;
  return {
    eventId,
    eventTime,
    payload: {
      deptId,
      occupancyId,
      ...(summary !== undefined ? { summary } : {}),
      ...(hazards !== undefined ? { hazards } : {}),
      ...(utilityShutoffs !== undefined ? { utilityShutoffs } : {}),
    },
  };
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

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

function buildCopyUpdate(payload: PrePlanUpdatedPayload, snapshotUpdatedAt: number) {
  const setClauses = [
    'entityType = :entityType',
    'snapshotUpdatedAt = :snapshotUpdatedAt',
    'prePlanUpdatedAt = :snapshotUpdatedAt',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'PRE_PLAN_COPY',
    ':snapshotUpdatedAt': snapshotUpdatedAt,
  };
  if (payload.summary !== undefined) {
    setClauses.push('summary = :summary');
    values[':summary'] = payload.summary;
  }
  if (payload.hazards !== undefined) {
    setClauses.push('hazards = :hazards');
    values[':hazards'] = payload.hazards;
  }
  if (payload.utilityShutoffs !== undefined) {
    setClauses.push('utilityShutoffs = :utilityShutoffs');
    values[':utilityShutoffs'] = payload.utilityShutoffs;
  }
  return { UpdateExpression: `SET ${setClauses.join(', ')}`, values };
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: PrePlanUpdatedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('preplan_copy.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, payload } = envelope;
    const snapshotUpdatedAt = Date.parse(envelope.eventTime);
    const deptId = toVerifiedDeptId({ deptId: payload.deptId });
    const { UpdateExpression, values } = buildCopyUpdate(payload, snapshotUpdatedAt);

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, payload.occupancyId),
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
                Key: {
                  pk: buildDeptScopedPk(deptId, 'PREPLAN'),
                  sk: `OCCUPANCY#${payload.occupancyId}`,
                },
                UpdateExpression,
                ConditionExpression:
                  'attribute_not_exists(prePlanUpdatedAt) OR :snapshotUpdatedAt > prePlanUpdatedAt',
                ExpressionAttributeValues: values,
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
          logError('preplan_copy.duplicate_event_skipped', error, eventId, {
            occupancyId: payload.occupancyId,
          });
          emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyDuplicateSkipped');
          continue;
        }
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          logError('preplan_copy.stale_event_discarded', error, eventId, {
            occupancyId: payload.occupancyId,
          });
          emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyStaleDiscarded');
          continue;
        }
      }
      logError('preplan_copy.write_failed', error, eventId, { occupancyId: payload.occupancyId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyFailed');
      throw error;
    }

    const missingAc1Fields = (['summary', 'hazards', 'utilityShutoffs'] as const).filter(
      (field) => payload[field] === undefined,
    );
    if (missingAc1Fields.length > 0) {
      logError(
        'preplan_copy.written_with_missing_fields',
        new Error('inspections.preplan.updated payload omitted one or more AC1 attributes'),
        eventId,
        { occupancyId: payload.occupancyId, missingFields: missingAc1Fields },
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyMissingFields');
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyUpdated');
  }
};
