import type {
  Handler,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from './repository.js';
import { BUMP_CONTENT_VERSION, CONTENT_VERSION_VALUES, NOT_LOCKED_CONDITION } from './lock.js';

const METRIC_NAMESPACE = 'Boxalarm/IncidentRidingAssignment';
const MAX_UPDATE_ATTEMPTS = 5;

interface RidingAssignmentConsumerDeps {
  readonly client?: DynamoDBDocumentClient;
}

interface RidingAssignmentEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly apparatusId: string;
  readonly positionCode: string;
  readonly memberId: string | null;
}

function parseEnvelope(body: string): RidingAssignmentEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail;
  if (typeof detail !== 'object' || detail === null) {
    throw new Error('apparatus.riding_assignment message is missing detail');
  }
  const envelope = detail as {
    eventId?: unknown;
    eventTime?: unknown;
    payload?: {
      deptId?: unknown;
      dispatchId?: unknown;
      apparatusId?: unknown;
      positionCode?: unknown;
      memberId?: unknown;
    };
  };
  const payload = envelope.payload;
  if (
    typeof envelope.eventId !== 'string' ||
    envelope.eventId.length === 0 ||
    typeof envelope.eventTime !== 'string' ||
    envelope.eventTime.length === 0 ||
    !payload ||
    typeof payload.deptId !== 'string' ||
    payload.deptId.length === 0 ||
    typeof payload.dispatchId !== 'string' ||
    payload.dispatchId.length === 0 ||
    typeof payload.apparatusId !== 'string' ||
    payload.apparatusId.length === 0 ||
    typeof payload.positionCode !== 'string' ||
    payload.positionCode.length === 0 ||
    (payload.memberId !== null && typeof payload.memberId !== 'string')
  ) {
    throw new Error('apparatus.riding_assignment payload failed shape validation');
  }
  if (Number.isNaN(Date.parse(envelope.eventTime))) {
    throw new Error('apparatus.riding_assignment eventTime is not a valid date');
  }
  return {
    eventId: envelope.eventId,
    eventTime: envelope.eventTime,
    deptId: toVerifiedDeptId({ deptId: payload.deptId }),
    dispatchId: payload.dispatchId,
    apparatusId: payload.apparatusId,
    positionCode: payload.positionCode,
    memberId: payload.memberId,
  };
}

function logError(event: string, error: unknown, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      service: 'incident-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

interface SeatState {
  readonly memberId: string | null;
  readonly updatedAt: number;
}

function isSeatState(value: unknown): value is SeatState {
  const seat = value as Partial<SeatState> | null;
  return (
    typeof seat === 'object' &&
    seat !== null &&
    typeof seat.updatedAt === 'number' &&
    (seat.memberId === null || typeof seat.memberId === 'string')
  );
}

function readSeats(existing: unknown): Record<string, SeatState> {
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return {};
  return Object.fromEntries(Object.entries(existing).filter(([, seat]) => isSeatState(seat)));
}

function assignedMembers(seats: Record<string, SeatState>): string[] {
  const members = Object.values(seats)
    .map((seat) => seat.memberId)
    .filter((id): id is string => id !== null);
  return [...new Set(members)];
}

type UpdateOutcome = 'updated' | 'stale' | 'locked';

async function updateResponseUnit(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: { readonly pk: string; readonly sk: string },
  apparatusId: string,
  positionCode: string,
  memberId: string | null,
  eventUpdatedAt: number,
): Promise<UpdateOutcome> {
  // Until the report exists (the dispatch is still running) there is no METADATA row to
  // version or lock; the first failed METADATA condition tells which case this is.
  let reportExists = true;
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: key }));
    const existingItem = existing.Item as { seats?: unknown } | undefined;
    const priorSeats = readSeats(existingItem?.seats);
    const priorSeatUpdatedAt = priorSeats[positionCode]?.updatedAt;
    if (priorSeatUpdatedAt !== undefined && priorSeatUpdatedAt > eventUpdatedAt) {
      return 'stale';
    }
    const nextSeats = { ...priorSeats, [positionCode]: { memberId, updatedAt: eventUpdatedAt } };
    const seatsCondition = !existingItem
      ? 'attribute_not_exists(pk)'
      : existingItem.seats === undefined
        ? 'attribute_not_exists(seats)'
        : 'seats = :priorSeats';

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: key,
                ConditionExpression: seatsCondition,
                UpdateExpression:
                  'SET entityType = :entityType, unitType = :unitType, unitId = :unitId, seats = :seats, assignedPositions = :next',
                ExpressionAttributeValues: {
                  ':entityType': 'INCIDENT_RESPONSE_UNIT',
                  ':unitType': 'APPARATUS',
                  ':unitId': apparatusId,
                  ':seats': nextSeats,
                  ':next': assignedMembers(nextSeats),
                  ...(seatsCondition === 'seats = :priorSeats'
                    ? { ':priorSeats': existingItem?.seats }
                    : {}),
                },
              },
            },
            // Staffing feeds NERIS unit responses, so it is a content write like any other:
            // refused on a report locked for review (or already sent), and it bumps the
            // report's contentVersion so a lock pinned before it fails (review M5, round 2
            // N3). Before the report exists there is nothing to version or lock.
            ...(reportExists
              ? [
                  {
                    Update: {
                      TableName: tableName,
                      Key: { ...key, sk: 'METADATA' },
                      ConditionExpression: `attribute_exists(pk) AND ${NOT_LOCKED_CONDITION}`,
                      UpdateExpression: `SET ${BUMP_CONTENT_VERSION}`,
                      ExpressionAttributeValues: { ...CONTENT_VERSION_VALUES },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
      return 'updated';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        if (reasons[1]?.Code === 'ConditionalCheckFailed') {
          const metadata = await client.send(
            new GetCommand({
              TableName: tableName,
              Key: { ...key, sk: 'METADATA' },
              ConsistentRead: true,
            }),
          );
          if (metadata.Item) return 'locked';
          reportExists = false;
          continue;
        }
        if (reasons[0]?.Code === 'ConditionalCheckFailed') continue;
      }
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    'INCIDENT_RESPONSE_UNIT assignedPositions update exceeded retry attempts on concurrent writers',
  );
}

async function processRecord(record: SQSRecord, deps: RidingAssignmentConsumerDeps): Promise<void> {
  let envelope: RidingAssignmentEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logError('incident.ridingAssignment.malformed', error, { correlationId: record.messageId });
    throw error;
  }

  const { eventId, eventTime, deptId, dispatchId, apparatusId, positionCode, memberId } = envelope;
  const tableName = getTableName(process.env);
  const client = deps.client ?? getDocumentClient();
  const dedupKey = {
    pk: buildDeptScopedPk(deptId, 'DEDUP', 'riding-assignment'),
    sk: `EVT#${eventId}`,
  };

  let dedupExisting;
  try {
    dedupExisting = await client.send(new GetCommand({ TableName: tableName, Key: dedupKey }));
  } catch (error) {
    logError('incident.ridingAssignment.dedupCheckFailed', error, { correlationId: eventId });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'RidingAssignmentFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
  if (dedupExisting.Item) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentSkipped', 'DuplicateEvent');
    return;
  }

  const eventUpdatedAt = Date.parse(eventTime);
  const responseUnitKey = {
    pk: buildDeptScopedPk(deptId, 'INCIDENT', dispatchId),
    sk: `RESPONSE#${apparatusId}`,
  };

  try {
    const outcome = await updateResponseUnit(
      client,
      tableName,
      responseUnitKey,
      apparatusId,
      positionCode,
      memberId,
      eventUpdatedAt,
    );
    if (outcome === 'stale') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentSkipped', 'StaleEvent');
      return;
    }
    if (outcome === 'locked') {
      console.warn(
        JSON.stringify({
          event: 'incident.ridingAssignment.reportLocked',
          service: 'incident-service',
          correlationId: eventId,
          deptId,
          incidentId: dispatchId,
        }),
      );
      emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentSkipped', 'ReportLocked');
      return;
    }
  } catch (error) {
    logError('incident.ridingAssignment.updateFailed', error, { correlationId: eventId });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'RidingAssignmentFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...dedupKey, ttl: Math.floor(Date.now() / 1000) + 48 * 60 * 60 },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentUpdated');
      return;
    }
    logError('incident.ridingAssignment.dedupMarkFailed', error, { correlationId: eventId });
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentUpdated');
}

// Partial batch response: a failing record is reported alone (its error was already
// logged inside processRecord) so SQS redelivers only that record instead of the whole
// batch. Requires ReportBatchItemFailures on the event source mapping.
export function createHandler(
  deps: RidingAssignmentConsumerDeps = {},
): Handler<SQSEvent, SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record, deps);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createHandler();
