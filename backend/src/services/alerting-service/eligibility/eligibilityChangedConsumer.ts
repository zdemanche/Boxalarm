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

const METRIC_NAMESPACE = 'Boxalarm/AlertingEligibility';
const MAX_SNAPSHOT_UPDATE_ATTEMPTS = 5;

interface EligibilityChangedDeps {
  readonly client?: DynamoDBDocumentClient;
}

interface EligibilityChangedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly qualCode: string;
  readonly currentlyEligible: boolean;
}

function parseEnvelope(body: string): EligibilityChangedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail;
  if (typeof detail !== 'object' || detail === null) {
    throw new Error('personnel.eligibility.changed message is missing detail');
  }
  const envelope = detail as {
    eventId?: unknown;
    eventTime?: unknown;
    payload?: {
      deptId?: unknown;
      memberId?: unknown;
      qualCode?: unknown;
      currentlyEligible?: unknown;
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
    typeof payload.memberId !== 'string' ||
    payload.memberId.length === 0 ||
    typeof payload.qualCode !== 'string' ||
    payload.qualCode.length === 0 ||
    typeof payload.currentlyEligible !== 'boolean'
  ) {
    throw new Error('personnel.eligibility.changed payload failed shape validation');
  }
  if (Number.isNaN(Date.parse(envelope.eventTime))) {
    throw new Error('personnel.eligibility.changed eventTime is not a valid date');
  }
  return {
    eventId: envelope.eventId,
    eventTime: envelope.eventTime,
    deptId: toVerifiedDeptId({ deptId: payload.deptId }),
    memberId: payload.memberId,
    qualCode: payload.qualCode,
    currentlyEligible: payload.currentlyEligible,
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

function nextQuals(existing: unknown, qualCode: string, currentlyEligible: boolean): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const withoutQual = current.filter((entry) => entry !== qualCode);
  return currentlyEligible ? [...withoutQual, qualCode] : withoutQual;
}

type SnapshotUpdateOutcome = 'updated' | 'stale';

async function updateEligibilitySnapshot(
  client: DynamoDBDocumentClient,
  tableName: string,
  snapshotKey: { readonly pk: string; readonly sk: string },
  memberId: string,
  qualCode: string,
  currentlyEligible: boolean,
  eventSnapshotUpdatedAt: number,
): Promise<SnapshotUpdateOutcome> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_UPDATE_ATTEMPTS; attempt += 1) {
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: snapshotKey }));
    const existingItem = existing.Item as { quals?: unknown; qualsUpdatedAt?: unknown } | undefined;
    // Deliberately gate staleness on our own qualsUpdatedAt field, not the shared
    // snapshotUpdatedAt also written by eligibility-consumer (personnel.availability.changed).
    // Two independent, uncorrelated event streams write this same snapshot item; comparing
    // against a shared timestamp means a later-arriving-but-unrelated availability update
    // could make an otherwise-valid, still-current qual update look "stale" and get silently
    // dropped (or vice versa). See consumer.ts's own snapshotUpdatedAt gate.
    const priorQualsUpdatedAt =
      typeof existingItem?.qualsUpdatedAt === 'number' ? existingItem.qualsUpdatedAt : undefined;
    if (priorQualsUpdatedAt !== undefined && priorQualsUpdatedAt > eventSnapshotUpdatedAt) {
      return 'stale';
    }
    const priorQuals = Array.isArray(existingItem?.quals) ? existingItem.quals : [];
    const quals = nextQuals(priorQuals, qualCode, currentlyEligible);

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: snapshotKey,
          ConditionExpression:
            'attribute_not_exists(pk) OR if_not_exists(quals, :emptyList) = :priorQuals',
          UpdateExpression:
            'SET entityType = :entityType, memberId = :memberId, quals = :quals, qualsUpdatedAt = :new, snapshotUpdatedAt = if_not_exists(snapshotUpdatedAt, :new), active = if_not_exists(active, :defaultActive), availabilityState = if_not_exists(availabilityState, :defaultAvailability), roles = if_not_exists(roles, :emptyList)',
          ExpressionAttributeValues: {
            ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
            ':memberId': memberId,
            ':quals': quals,
            ':priorQuals': priorQuals,
            ':new': eventSnapshotUpdatedAt,
            ':defaultActive': true,
            ':defaultAvailability': 'AVAILABLE',
            ':emptyList': [],
          },
        }),
      );
      return 'updated';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('eligibility snapshot update exceeded retry attempts on concurrent writers');
}

async function processRecord(record: SQSRecord, deps: EligibilityChangedDeps): Promise<void> {
  let envelope: EligibilityChangedEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logError('alerting.eligibility.changed.malformed', error, { correlationId: record.messageId });
    throw error;
  }

  const { eventId, eventTime, deptId, memberId, qualCode, currentlyEligible } = envelope;
  const { tableName } = readAlertingConfig(process.env);
  const client = createDynamoClient(process.env, deps.client);
  const dedupKey = {
    pk: buildDeptScopedPk(deptId, 'DEDUP', 'member-eligibility-changed'),
    sk: `EVT#${eventId}`,
  };

  let dedupExisting;
  try {
    dedupExisting = await client.send(new GetCommand({ TableName: tableName, Key: dedupKey }));
  } catch (error) {
    logError('alerting.eligibility.changed.dedupCheckFailed', error, {
      correlationId: eventId,
      memberId,
    });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'EligibilityChangedFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
  if (dedupExisting.Item) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'EligibilityChangedSkipped', 'DuplicateEvent');
    return;
  }

  const snapshotUpdatedAt = Date.parse(eventTime);
  const snapshotKey = { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${memberId}` };

  try {
    const outcome = await updateEligibilitySnapshot(
      client,
      tableName,
      snapshotKey,
      memberId,
      qualCode,
      currentlyEligible,
      snapshotUpdatedAt,
    );
    if (outcome === 'stale') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'EligibilityChangedSkipped', 'StaleEvent');
      return;
    }
  } catch (error) {
    logError('alerting.eligibility.changed.updateFailed', error, {
      correlationId: eventId,
      memberId,
    });
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      'EligibilityChangedFailed',
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
      emitOutcomeMetric(METRIC_NAMESPACE, 'EligibilityChangedUpdated');
      return;
    }
    logError('alerting.eligibility.changed.dedupMarkFailed', error, {
      correlationId: eventId,
      memberId,
    });
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'EligibilityChangedUpdated');
}

export function createHandler(deps: EligibilityChangedDeps = {}): Handler<SQSEvent, void> {
  return async (event) => {
    for (const record of event.Records) {
      await processRecord(record, deps);
    }
  };
}

export const handler = createHandler();
