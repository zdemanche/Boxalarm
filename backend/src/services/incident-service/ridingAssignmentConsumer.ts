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
  readonly memberId: string | null;
  readonly previousMemberId: string | null;
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
      memberId?: unknown;
      previousMemberId?: unknown;
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
    (payload.memberId !== null && typeof payload.memberId !== 'string') ||
    (payload.previousMemberId !== null && typeof payload.previousMemberId !== 'string')
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
    memberId: payload.memberId,
    previousMemberId: payload.previousMemberId,
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

function nextAssignedPositions(
  existing: unknown,
  memberId: string | null,
  previousMemberId: string | null,
): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const withoutPrevious =
    previousMemberId !== null ? current.filter((id) => id !== previousMemberId) : current;
  if (memberId !== null && !withoutPrevious.includes(memberId)) {
    return [...withoutPrevious, memberId];
  }
  return withoutPrevious;
}

type UpdateOutcome = 'updated' | 'stale' | 'locked';

async function updateResponseUnit(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: { readonly pk: string; readonly sk: string },
  apparatusId: string,
  memberId: string | null,
  previousMemberId: string | null,
  eventUpdatedAt: number,
): Promise<UpdateOutcome> {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: key }));
    const existingItem = existing.Item as
      { assignedPositions?: unknown; assignedPositionsUpdatedAt?: unknown } | undefined;
    const priorUpdatedAt =
      typeof existingItem?.assignedPositionsUpdatedAt === 'number'
        ? existingItem.assignedPositionsUpdatedAt
        : undefined;
    if (priorUpdatedAt !== undefined && priorUpdatedAt > eventUpdatedAt) {
      return 'stale';
    }
    const priorPositions = Array.isArray(existingItem?.assignedPositions)
      ? existingItem.assignedPositions
      : [];
    const nextPositions = nextAssignedPositions(priorPositions, memberId, previousMemberId);

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: key,
                ConditionExpression:
                  'attribute_not_exists(pk) OR if_not_exists(assignedPositions, :emptyList) = :priorPositions',
                UpdateExpression:
                  'SET entityType = :entityType, unitType = :unitType, unitId = :unitId, assignedPositions = :next, assignedPositionsUpdatedAt = :new',
                ExpressionAttributeValues: {
                  ':entityType': 'INCIDENT_RESPONSE_UNIT',
                  ':unitType': 'APPARATUS',
                  ':unitId': apparatusId,
                  ':next': nextPositions,
                  ':priorPositions': priorPositions,
                  ':emptyList': [],
                  ':new': eventUpdatedAt,
                },
              },
            },
            {
              // Staffing feeds NERIS unit responses: a report locked for review (or already
              // sent) is not changed behind the officer's back (review M5). A missing report
              // (the dispatch is still running) passes: it cannot be locked yet.
              ConditionCheck: {
                TableName: tableName,
                Key: { ...key, sk: 'METADATA' },
                ConditionExpression: 'attribute_not_exists(lockedAt)',
              },
            },
          ],
        }),
      );
      return 'updated';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        if (reasons[1]?.Code === 'ConditionalCheckFailed') return 'locked';
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

  const { eventId, eventTime, deptId, dispatchId, apparatusId, memberId, previousMemberId } =
    envelope;
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
      memberId,
      previousMemberId,
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
