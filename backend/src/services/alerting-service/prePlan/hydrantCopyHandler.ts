import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { hydrantCopyKey, hydrantGeoIndexKeys } from './copyKeys.js';
import { isGeoPoint } from './geo.js';
import { parseHydrantUpdatePayload, type HydrantUpdatePayload } from './nearestHydrants.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-pre-plan';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'hydrant-copy-consumer';

interface HydrantUpdatedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly payload: HydrantUpdatePayload;
}

/**
 * The queue is fed by an EventBridge rule target with no input transformer, so each SQS body
 * is the whole EventBridge event and the outbox envelope sits under `detail`.
 */
function parseEnvelope(body: string): HydrantUpdatedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const raw = parsed.detail;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('inspections.hydrant.updated message is missing detail');
  }
  const envelope = raw as Record<string, unknown>;
  const eventId = envelope.eventId;
  const eventTime = envelope.eventTime;
  if (
    typeof eventId !== 'string' ||
    typeof eventTime !== 'string' ||
    !Number.isFinite(Date.parse(eventTime))
  ) {
    throw new Error('inspections.hydrant.updated event failed shape validation');
  }
  const payload = parseHydrantUpdatePayload(envelope.payload);
  return { eventId, eventTime, payload };
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

/**
 * One HYDRANT_COPY per hydrant, geo-indexed so the dispatch-detail route can find the nearest
 * hydrants to any point at read time. Only the fields the event carries are set, so a
 * status-only event never blanks a known size or flow rating.
 */
function buildCopyUpdate(
  deptId: VerifiedDeptId,
  payload: HydrantUpdatePayload,
  hydrantUpdatedAt: number,
) {
  if (payload.archived) {
    // Off the geo index for good; archivedAt blocks any later non-archive event.
    return {
      UpdateExpression:
        'SET entityType = :entityType, hydrantId = :hydrantId, hydrantUpdatedAt = :hydrantUpdatedAt, ' +
        'archivedAt = :hydrantUpdatedAt REMOVE gsi2pk, gsi2sk',
      ExpressionAttributeValues: {
        ':entityType': 'HYDRANT_COPY',
        ':hydrantId': payload.hydrantId,
        ':hydrantUpdatedAt': hydrantUpdatedAt,
      } as Record<string, unknown>,
    };
  }
  const setClauses = [
    'entityType = :entityType',
    'hydrantId = :hydrantId',
    'hydrantUpdatedAt = :hydrantUpdatedAt',
  ];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':entityType': 'HYDRANT_COPY',
    ':hydrantId': payload.hydrantId,
    ':hydrantUpdatedAt': hydrantUpdatedAt,
  };
  const assign = (field: string, value: unknown) => {
    if (value !== undefined) {
      // `status` and `size` are DynamoDB reserved words.
      names[`#${field}`] = field;
      setClauses.push(`#${field} = :${field}`);
      values[`:${field}`] = value;
    }
  };
  assign('status', payload.status);
  assign('size', payload.size);
  assign('flowRatingGpm', payload.flowRatingGpm);
  const location = { latitude: payload.latitude, longitude: payload.longitude };
  if (isGeoPoint(location)) {
    const geoIndex = hydrantGeoIndexKeys(deptId, location, payload.hydrantId);
    assign('latitude', location.latitude);
    assign('longitude', location.longitude);
    assign('geohash', geoIndex.geohash);
    assign('gsi2pk', geoIndex.gsi2pk);
    assign('gsi2sk', geoIndex.gsi2sk);
  }
  return {
    UpdateExpression: `SET ${setClauses.join(', ')}`,
    // DynamoDB rejects an empty ExpressionAttributeNames map (an id-only event).
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  };
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: HydrantUpdatedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('hydrant_copy.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, payload } = envelope;
    const hydrantUpdatedAt = Date.parse(envelope.eventTime);
    const deptId = toVerifiedDeptId({ deptId: payload.deptId });

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'DEDUP', CONSUMER_NAME, payload.hydrantId),
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
                Key: hydrantCopyKey(deptId, payload.hydrantId),
                ...buildCopyUpdate(deptId, payload, hydrantUpdatedAt),
                ConditionExpression:
                  '(attribute_not_exists(hydrantUpdatedAt) OR :hydrantUpdatedAt > hydrantUpdatedAt) AND attribute_not_exists(archivedAt)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      const reasons = asTransactionCancellation(error)?.CancellationReasons ?? [];
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        logError('hydrant_copy.duplicate_event_skipped', error, eventId, {
          hydrantId: payload.hydrantId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyDuplicateSkipped');
        continue;
      }
      if (reasons[1]?.Code === 'ConditionalCheckFailed') {
        logError('hydrant_copy.stale_event_discarded', error, eventId, {
          hydrantId: payload.hydrantId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyStaleDiscarded');
        continue;
      }
      logError('hydrant_copy.write_failed', error, eventId, { hydrantId: payload.hydrantId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyFailed');
      throw error;
    }

    if (payload.archived) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyArchived');
      continue;
    }
    if (payload.latitude === undefined) {
      // Stored, but off the geo index: no dispatch will ever list it as a nearest hydrant.
      logError(
        'hydrant_copy.written_without_location',
        new Error('inspections.hydrant.updated payload carried no usable latitude/longitude'),
        eventId,
        { hydrantId: payload.hydrantId },
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyMissingLocation');
    }
    emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyUpdated');
  }
};
