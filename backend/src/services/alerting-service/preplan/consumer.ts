import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import type { HydrantRef, UtilityShutoff } from './prePlanCopyRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingPrePlanCopy';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'preplan-copy-consumer';
const DEDUP_ITEM_INDEX = 0;
const COPY_ITEM_INDEX = 1;

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

interface PrePlanCopyEnvelope {
  readonly eventId: string;
  readonly eventTime: number;
  readonly deptId: string;
  readonly occupancyId: string;
  readonly summary?: string;
  readonly hazards?: readonly string[];
  readonly utilityShutoffs?: readonly UtilityShutoff[];
  readonly nearestHydrants?: readonly HydrantRef[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)
  );
}

function parseEnvelope(body: string): PrePlanCopyEnvelope {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const eventId = raw.eventId;
  const eventTimeRaw = raw.eventTime;
  const eventTime = typeof eventTimeRaw === 'string' ? Date.parse(eventTimeRaw) : NaN;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const occupancyId = payload?.occupancyId;
  if (
    typeof eventId !== 'string' ||
    !Number.isFinite(eventTime) ||
    typeof deptId !== 'string' ||
    typeof occupancyId !== 'string'
  ) {
    throw new Error('preplan copy event failed shape validation');
  }

  const summary = payload?.summary;
  if (summary !== undefined && typeof summary !== 'string') {
    throw new Error('preplan copy event summary must be a string when present');
  }
  const hazards = payload?.hazards;
  if (hazards !== undefined && !isStringArray(hazards)) {
    throw new Error('preplan copy event hazards must be an array of strings when present');
  }
  const utilityShutoffs = payload?.utilityShutoffs;
  if (utilityShutoffs !== undefined && !isRecordArray(utilityShutoffs)) {
    throw new Error('preplan copy event utilityShutoffs must be an array when present');
  }
  const nearestHydrants = payload?.nearestHydrants;
  if (nearestHydrants !== undefined && !isRecordArray(nearestHydrants)) {
    throw new Error('preplan copy event nearestHydrants must be an array when present');
  }

  return {
    eventId,
    eventTime,
    deptId,
    occupancyId,
    ...(summary !== undefined ? { summary } : {}),
    ...(hazards !== undefined ? { hazards } : {}),
    ...(utilityShutoffs !== undefined ? { utilityShutoffs } : {}),
    ...(nearestHydrants !== undefined ? { nearestHydrants } : {}),
  };
}

function buildUpdate(envelope: PrePlanCopyEnvelope): {
  expression: string;
  values: Record<string, unknown>;
} {
  const setParts = ['entityType = :entityType', 'snapshotUpdatedAt = :now'];
  const values: Record<string, unknown> = {
    ':entityType': 'PRE_PLAN_COPY',
    ':now': envelope.eventTime,
  };
  if (envelope.summary !== undefined) {
    setParts.push('summary = :summary');
    values[':summary'] = envelope.summary;
  }
  if (envelope.hazards !== undefined) {
    setParts.push('hazards = :hazards');
    values[':hazards'] = envelope.hazards;
  }
  if (envelope.utilityShutoffs !== undefined) {
    setParts.push('utilityShutoffs = :utilityShutoffs');
    values[':utilityShutoffs'] = envelope.utilityShutoffs;
  }
  if (envelope.nearestHydrants !== undefined) {
    setParts.push('nearestHydrants = :nearestHydrants');
    values[':nearestHydrants'] = envelope.nearestHydrants;
  }
  return { expression: `SET ${setParts.join(', ')}`, values };
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: PrePlanCopyEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('preplan_copy.malformed_event', error, { messageId: record.messageId });
      throw error;
    }

    const { eventId, occupancyId } = envelope;
    const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
    const update = buildUpdate(envelope);

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, occupancyId),
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
                Key: { pk: buildDeptScopedPk(deptId, 'PREPLAN'), sk: `OCCUPANCY#${occupancyId}` },
                UpdateExpression: update.expression,
                ConditionExpression: 'attribute_not_exists(pk) OR :now > snapshotUpdatedAt',
                ExpressionAttributeValues: update.values,
              },
            },
          ],
        }),
      );
    } catch (error) {
      const cancellation = asTransactionCancellation(error);
      if (cancellation) {
        const reasons = cancellation.CancellationReasons ?? [];
        if (reasons[DEDUP_ITEM_INDEX]?.Code === 'ConditionalCheckFailed') {
          emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
          continue;
        }
        if (reasons[COPY_ITEM_INDEX]?.Code === 'ConditionalCheckFailed') {
          logError('preplan_copy.snapshot_update_skipped', error, {
            deptId,
            occupancyId,
            cancellationReasons: reasons.map((reason) => reason.Code),
          });
          emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateSkipped');
          continue;
        }
        logError('preplan_copy.snapshot_update_failed', error, {
          deptId,
          occupancyId,
          cancellationReasons: reasons.map((reason) => reason.Code),
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateFailed');
        throw error;
      }
      logError('preplan_copy.snapshot_update_failed', error, { deptId, occupancyId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdateFailed');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'SnapshotUpdated');
  }
};
