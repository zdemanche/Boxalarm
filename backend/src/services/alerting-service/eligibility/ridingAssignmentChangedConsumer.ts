import type { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from './dynamoClient.js';
import { logError as logStructuredError } from '../logger.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingRidingAssignment';

interface RidingAssignmentChangedDeps {
  readonly client?: DynamoDBDocumentClient;
}

interface RidingAssignmentChangedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly apparatusId: string;
  readonly memberId: string | null;
  readonly previousMemberId: string | null;
}

function parseEnvelope(body: string): RidingAssignmentChangedEnvelope {
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
  logStructuredError({
    event,
    service: 'alerting-service',
    ...context,
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : undefined,
  });
}

async function updateAssignedApparatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  apparatusId: string | null,
  eventTimeMs: number,
  requireCurrentApparatusId?: string,
): Promise<void> {
  const conditions = [
    'attribute_exists(pk)',
    '(attribute_not_exists(assignedApparatusUpdatedAt) OR assignedApparatusUpdatedAt < :new)',
  ];
  const values: Record<string, unknown> = { ':apparatusId': apparatusId, ':new': eventTimeMs };
  if (requireCurrentApparatusId !== undefined) {
    conditions.push('assignedApparatusId = :requireCurrentApparatusId');
    values[':requireCurrentApparatusId'] = requireCurrentApparatusId;
  }
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: `ROSTER#${memberId}` },
        ConditionExpression: conditions.join(' AND '),
        UpdateExpression: 'SET assignedApparatusId = :apparatusId, assignedApparatusUpdatedAt = :new',
        ExpressionAttributeValues: values,
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentChangedSkippedNoMatch');
      return;
    }
    throw error;
  }
}

async function processRecord(record: SQSRecord, deps: RidingAssignmentChangedDeps): Promise<void> {
  let envelope: RidingAssignmentChangedEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logError('alerting.ridingAssignment.changed.malformed', error, { correlationId: record.messageId });
    throw error;
  }

  const { eventId, eventTime, deptId, dispatchId, apparatusId, memberId, previousMemberId } = envelope;
  const { tableName } = readAlertingConfig(process.env);
  const client = createDynamoClient(process.env, deps.client);
  const dedupKey = {
    pk: buildDeptScopedPk(deptId, 'DEDUP', 'riding-assignment-changed'),
    sk: `EVT#${eventId}`,
  };

  let dedupExisting;
  try {
    dedupExisting = await client.send(new GetCommand({ TableName: tableName, Key: dedupKey }));
  } catch (error) {
    logError('alerting.ridingAssignment.changed.dedupCheckFailed', error, { correlationId: eventId });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'RidingAssignmentChangedFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
  if (dedupExisting.Item) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentChangedSkipped', 'DuplicateEvent');
    return;
  }

  const eventTimeMs = Date.parse(eventTime);
  try {
    if (memberId !== null) {
      await updateAssignedApparatus(client, tableName, deptId, dispatchId, memberId, apparatusId, eventTimeMs);
    }
    if (previousMemberId !== null && previousMemberId !== memberId) {
      // Only clear the displaced member's assignment if they're still shown riding *this*
      // apparatus -- they may have since been assigned a different seat entirely (seats are
      // not auto-vacated), in which case clearing here would wrongly un-seat them.
      await updateAssignedApparatus(
        client,
        tableName,
        deptId,
        dispatchId,
        previousMemberId,
        null,
        eventTimeMs,
        apparatusId,
      );
    }
  } catch (error) {
    logError('alerting.ridingAssignment.changed.updateFailed', error, { correlationId: eventId });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'RidingAssignmentChangedFailed',
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
      emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentChangedUpdated');
      return;
    }
    logError('alerting.ridingAssignment.changed.dedupMarkFailed', error, { correlationId: eventId });
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'RidingAssignmentChangedUpdated');
}

export function createHandler(deps: RidingAssignmentChangedDeps = {}): Handler<SQSEvent, void> {
  return async (event) => {
    for (const record of event.Records) {
      await processRecord(record, deps);
    }
  };
}

export const handler = createHandler();
