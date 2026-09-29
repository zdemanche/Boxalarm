import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { normalizeAddress } from './addressKey.js';
import { prePlanAddressIndexKeys, prePlanCopyKey, prePlanGeoIndexKeys } from './copyKeys.js';
import { isGeoPoint, type GeoPoint } from './geo.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-pre-plan';
const DEDUP_TTL_SECONDS = 48 * 60 * 60;
const CONSUMER_NAME = 'preplan-copy-consumer';

interface UtilityShutoff {
  readonly utility: string;
  readonly location: string;
}

interface PrePlanUpdatedPayload {
  readonly deptId: string;
  readonly occupancyId: string;
  /** The occupancy was archived: tombstone the copy (inspections archive/archiveRepository.ts). */
  readonly archived?: true;
  readonly prePlanId?: string;
  readonly summary?: string;
  readonly occupancyType?: string;
  readonly address?: string;
  readonly location?: GeoPoint;
  readonly hazards?: readonly string[];
  readonly utilityShutoffs?: readonly UtilityShutoff[];
}

interface PrePlanUpdatedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly payload: PrePlanUpdatedPayload;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The queue is fed by an EventBridge rule target with no input transformer, so each SQS body
 * is the whole EventBridge event and the outbox envelope sits under `detail` (the same
 * contract memberUpdatedHandler parses).
 */
function parseEnvelope(body: string): PrePlanUpdatedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const raw = parsed.detail;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('inspections.preplan.updated message is missing detail');
  }
  const envelope = raw as Record<string, unknown>;
  const eventId = envelope.eventId;
  const eventTime = envelope.eventTime;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const occupancyId = payload?.occupancyId;
  if (
    typeof eventId !== 'string' ||
    typeof eventTime !== 'string' ||
    !Number.isFinite(Date.parse(eventTime)) ||
    typeof deptId !== 'string' ||
    typeof occupancyId !== 'string' ||
    occupancyId.length === 0
  ) {
    throw new Error('inspections.preplan.updated event failed shape validation');
  }
  const hazards = Array.isArray(payload?.hazards) ? (payload.hazards as string[]) : undefined;
  const utilityShutoffs = Array.isArray(payload?.utilityShutoffs)
    ? (payload.utilityShutoffs as UtilityShutoff[])
    : undefined;
  const location = { latitude: payload?.latitude, longitude: payload?.longitude };
  const optional = {
    prePlanId: optionalString(payload?.prePlanId),
    summary: optionalString(payload?.summary),
    occupancyType: optionalString(payload?.occupancyType),
    address: optionalString(payload?.address),
  };
  return {
    eventId,
    eventTime,
    payload: {
      deptId,
      occupancyId,
      ...(payload?.archived === true ? { archived: true as const } : {}),
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      ...(isGeoPoint(location) ? { location } : {}),
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

/**
 * An archived occupancy's copy keeps its content for the record but loses every index key, so
 * no dispatch can reach it again; archivedAt also blocks any later non-archive event.
 */
function buildTombstoneUpdate(payload: PrePlanUpdatedPayload, snapshotUpdatedAt: number) {
  return {
    UpdateExpression:
      'SET entityType = :entityType, occupancyId = :occupancyId, archivedAt = :snapshotUpdatedAt, ' +
      'snapshotUpdatedAt = :snapshotUpdatedAt, prePlanUpdatedAt = :snapshotUpdatedAt ' +
      'REMOVE gsi1pk, gsi1sk, gsi2pk, gsi2sk',
    values: {
      ':entityType': 'PRE_PLAN_COPY',
      ':occupancyId': payload.occupancyId,
      ':snapshotUpdatedAt': snapshotUpdatedAt,
    } as Record<string, unknown>,
  };
}

function buildCopyUpdate(
  deptId: VerifiedDeptId,
  payload: PrePlanUpdatedPayload,
  snapshotUpdatedAt: number,
) {
  if (payload.archived) {
    return buildTombstoneUpdate(payload, snapshotUpdatedAt);
  }
  const setClauses = [
    'entityType = :entityType',
    'occupancyId = :occupancyId',
    'snapshotUpdatedAt = :snapshotUpdatedAt',
    'prePlanUpdatedAt = :snapshotUpdatedAt',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'PRE_PLAN_COPY',
    ':occupancyId': payload.occupancyId,
    ':snapshotUpdatedAt': snapshotUpdatedAt,
  };
  const assign = (field: string, value: unknown) => {
    if (value !== undefined) {
      setClauses.push(`${field} = :${field}`);
      values[`:${field}`] = value;
    }
  };
  assign('prePlanId', payload.prePlanId);
  assign('summary', payload.summary);
  assign('occupancyType', payload.occupancyType);
  assign('hazards', payload.hazards);
  assign('utilityShutoffs', payload.utilityShutoffs);

  // The address key is recomputed here with the alerting plane's own normalizer — never taken
  // from the producer's normalizedAddress — so the dispatch side and the copy side of the
  // match always run the same rules.
  const normalized = payload.address !== undefined ? normalizeAddress(payload.address) : null;
  assign('address', payload.address);
  if (normalized) {
    assign('addressKey', normalized.key);
    assign('addressUnit', normalized.unit ?? undefined);
    assign('addressTown', normalized.town ?? undefined);
    assign('addressZip', normalized.zip ?? undefined);
    const addressIndex = prePlanAddressIndexKeys(deptId, normalized.key, payload.occupancyId);
    assign('gsi1pk', addressIndex.gsi1pk);
    assign('gsi1sk', addressIndex.gsi1sk);
  }
  if (payload.location) {
    const geoIndex = prePlanGeoIndexKeys(deptId, payload.location, payload.occupancyId);
    assign('latitude', payload.location.latitude);
    assign('longitude', payload.location.longitude);
    assign('geohash', geoIndex.geohash);
    assign('gsi2pk', geoIndex.gsi2pk);
    assign('gsi2sk', geoIndex.gsi2sk);
  }
  return { UpdateExpression: `SET ${setClauses.join(', ')}`, values };
}

/**
 * Reports failures per message (the event source mapping sets ReportBatchItemFailures): a
 * malformed or unwritable record is retried — and eventually dead-lettered — on its own,
 * never taking the valid records of its batch down with it.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: PrePlanUpdatedEnvelope;
    let deptId: VerifiedDeptId;
    let update: ReturnType<typeof buildCopyUpdate>;
    try {
      envelope = parseEnvelope(record.body);
      deptId = toVerifiedDeptId({ deptId: envelope.payload.deptId });
      // Keys are built here too: an id carrying the pk delimiter is a malformed event.
      update = buildCopyUpdate(deptId, envelope.payload, Date.parse(envelope.eventTime));
    } catch (error) {
      logError('preplan_copy.malformed_event', error, record.messageId);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const { eventId, payload } = envelope;
    const { UpdateExpression, values } = update;

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
                Key: prePlanCopyKey(deptId, payload.occupancyId),
                UpdateExpression,
                // An update: newer than what is stored, and never over a tombstone (there is no
                // un-archive). A tombstone: unconditional beyond its dedup marker — event times
                // are stamped before commit, so a pre-plan save racing the archive can carry a
                // later eventTime, and a watermark would then discard the tombstone for good.
                ...(payload.archived
                  ? {}
                  : {
                      ConditionExpression:
                        '(attribute_not_exists(prePlanUpdatedAt) OR :snapshotUpdatedAt > prePlanUpdatedAt) AND attribute_not_exists(archivedAt)',
                    }),
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
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    // The address is what makes the copy findable from a dispatch: without it the copy is
    // stored but no alert will ever show it. (Coordinates are optional on an occupancy.)
    if (payload.archived) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'PrePlanCopyArchived');
      continue;
    }
    const missingAc1Fields = (['summary', 'hazards', 'utilityShutoffs', 'address'] as const).filter(
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
  return { batchItemFailures };
};
