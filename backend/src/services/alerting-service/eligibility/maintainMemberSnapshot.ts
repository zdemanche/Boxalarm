import type { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';

export const CONTACT_CHANNEL_SMS = 'sms';

const LATENCY_METRIC_NAMESPACE = 'Boxalarm/AlertingEligibility';

interface SnapshotDeps {
  readonly client?: DynamoDBDocumentClient;
}

interface MemberUpdatedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly phone: string | undefined;
}

interface ContactChannel {
  readonly channel: string;
  readonly token: string;
}

function readSnapshotConfig(env: NodeJS.ProcessEnv): { tableName: string } {
  const tableName = env.ALERTING_TABLE_NAME;
  if (!tableName) {
    throw new Error('ALERTING_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

function parseEnvelope(body: string): MemberUpdatedEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const detail = (parsed as { detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) {
    return undefined;
  }
  const envelope = detail as {
    eventId?: unknown;
    eventTime?: unknown;
    payload?: { deptId?: unknown; memberId?: unknown; phone?: unknown };
  };
  const eventId = typeof envelope.eventId === 'string' ? envelope.eventId : undefined;
  const eventTime = typeof envelope.eventTime === 'string' ? envelope.eventTime : undefined;
  const deptIdRaw =
    typeof envelope.payload?.deptId === 'string' ? envelope.payload.deptId : undefined;
  const memberId =
    typeof envelope.payload?.memberId === 'string' ? envelope.payload.memberId : undefined;
  const phone = typeof envelope.payload?.phone === 'string' ? envelope.payload.phone : undefined;
  if (!eventId || !eventTime || !deptIdRaw || !memberId) {
    return undefined;
  }
  return { eventId, eventTime, deptId: toVerifiedDeptId({ deptId: deptIdRaw }), memberId, phone };
}

function mergeContactChannels(existing: unknown, phone: string | undefined): ContactChannel[] {
  const current = Array.isArray(existing)
    ? existing.filter((entry): entry is ContactChannel => {
        const candidate = entry as { channel?: unknown; token?: unknown };
        return typeof candidate.channel === 'string' && typeof candidate.token === 'string';
      })
    : [];
  if (phone === undefined) {
    return current;
  }
  return [
    ...current.filter((entry) => entry.channel !== CONTACT_CHANNEL_SMS),
    { channel: CONTACT_CHANNEL_SMS, token: phone },
  ];
}

function emitSnapshotMetric(
  outcome:
    | 'MemberEligibilitySnapshotUpdated'
    | 'MemberEligibilitySnapshotSkipped'
    | 'MemberEligibilitySnapshotUpdateFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Alerting',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

let cachedClient: DynamoDBDocumentClient | undefined;

function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

async function processRecord(record: SQSRecord, deps: SnapshotDeps): Promise<void> {
  const envelope = parseEnvelope(record.body);
  if (!envelope) {
    console.error(
      JSON.stringify({
        event: 'alerting.eligibility.snapshot.malformed',
        service: 'alerting-service',
        correlationId: record.messageId,
      }),
    );
    throw new Error('personnel.member.updated message body is malformed');
  }
  const { eventId, eventTime, deptId, memberId, phone } = envelope;
  const config = readSnapshotConfig(process.env);
  const client = getDocClient(deps.client);

  let dedupExisting;
  try {
    dedupExisting = await client.send(
      new GetCommand({
        TableName: config.tableName,
        Key: {
          pk: buildDeptScopedPk(deptId, 'DEDUP', 'member-eligibility-snapshot'),
          sk: `EVT#${eventId}`,
        },
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'alerting.eligibility.snapshot.dedupCheckFailed',
        service: 'alerting-service',
        correlationId: eventId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitSnapshotMetric(
      'MemberEligibilitySnapshotUpdateFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  if (dedupExisting.Item) {
    emitSnapshotMetric('MemberEligibilitySnapshotSkipped', 'DuplicateEvent');
    return;
  }

  const snapshotUpdatedAt = Date.parse(eventTime);

  try {
    const existing = await client.send(
      new GetCommand({
        TableName: config.tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${memberId}` },
      }),
    );
    const existingItem = existing.Item as { contactChannels?: unknown } | undefined;
    const contactChannels = mergeContactChannels(existingItem?.contactChannels, phone);

    await client.send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'), sk: `MEMBER#${memberId}` },
        ConditionExpression: 'attribute_not_exists(pk) OR snapshotUpdatedAt < :new',
        UpdateExpression:
          'SET entityType = :entityType, contactChannels = :contactChannels, snapshotUpdatedAt = :new, active = if_not_exists(active, :defaultActive), availabilityState = if_not_exists(availabilityState, :defaultAvailability), roles = if_not_exists(roles, :emptyList), quals = if_not_exists(quals, :emptyList)',
        ExpressionAttributeValues: {
          ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
          ':contactChannels': contactChannels,
          ':new': snapshotUpdatedAt,
          ':defaultActive': true,
          ':defaultAvailability': 'AVAILABLE',
          ':emptyList': [],
        },
      }),
    );

    const latencyMs = Date.now() - snapshotUpdatedAt;
    if (latencyMs < 0) {
      console.warn(
        JSON.stringify({
          event: 'alerting.eligibility.snapshot_propagation.future_event_time',
          service: 'alerting-service',
          correlationId: memberId,
          memberId,
          latencyMs,
        }),
      );
    }
    emitEmf(LATENCY_METRIC_NAMESPACE, 'SnapshotPropagationLatencyMs', Math.max(latencyMs, 0), [[]]);
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitSnapshotMetric('MemberEligibilitySnapshotSkipped', 'StaleEvent');
      return;
    }
    console.error(
      JSON.stringify({
        event: 'alerting.eligibility.snapshot.updateFailed',
        service: 'alerting-service',
        correlationId: eventId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitSnapshotMetric(
      'MemberEligibilitySnapshotUpdateFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  try {
    await client.send(
      new PutCommand({
        TableName: config.tableName,
        Item: {
          pk: buildDeptScopedPk(deptId, 'DEDUP', 'member-eligibility-snapshot'),
          sk: `EVT#${eventId}`,
          ttl: Math.floor(Date.now() / 1000) + 48 * 60 * 60,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitSnapshotMetric('MemberEligibilitySnapshotUpdated');
      return;
    }
    console.error(
      JSON.stringify({
        event: 'alerting.eligibility.snapshot.dedupMarkFailed',
        service: 'alerting-service',
        correlationId: eventId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    throw error;
  }

  emitSnapshotMetric('MemberEligibilitySnapshotUpdated');
}

export function createHandler(deps: SnapshotDeps = {}): Handler<SQSEvent, void> {
  return async (event) => {
    for (const record of event.Records) {
      await processRecord(record, deps);
    }
  };
}

export const handler = createHandler();
