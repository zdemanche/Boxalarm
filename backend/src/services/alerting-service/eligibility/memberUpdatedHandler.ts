import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from './dynamoClient.js';
import { applyContactUpdate, pushEntriesFrom, type ContactUpdate } from './contactProjection.js';
import { normalizePhoneE164 } from './phone.js';

const LATENCY_METRIC_NAMESPACE = 'Boxalarm/AlertingEligibility';

interface MemberUpdatedPayload {
  readonly deptId: string;
  readonly memberId: string;
  readonly active?: boolean;
  readonly quals?: readonly string[];
  readonly roles?: readonly string[];
  readonly contactChannels?: readonly unknown[];
  /** The member's phone (createMember, updateMember); projected into SMS and VOICE entries. */
  readonly phone?: unknown;
  readonly availabilityState?: string;
}

interface MemberUpdatedEnvelope {
  readonly eventTime: string;
  readonly eventType: string;
  readonly payload: MemberUpdatedPayload;
}

function emitSnapshotMetric(outcome: 'Updated' | 'Stale' | 'Failed'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/push-token',
            Dimensions: [[]],
            Metrics: [{ Name: `EligibilitySnapshot${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      [`EligibilitySnapshot${outcome}`]: 1,
    }),
  );
}

/**
 * The queue is fed by an EventBridge rule target with no inputPath, so each SQS body is the
 * whole EventBridge event and the outbox envelope sits under `detail` — the same contract
 * eligibilityChangedConsumer parses.
 */
function parseEnvelope(body: string): MemberUpdatedEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail;
  if (typeof detail !== 'object' || detail === null) {
    throw new Error('personnel.member.updated message is missing detail');
  }
  const envelope = detail as Partial<MemberUpdatedEnvelope>;
  const payload = envelope.payload;
  if (!payload || typeof payload.memberId !== 'string' || payload.memberId.length === 0) {
    throw new Error('personnel.member.updated payload is missing memberId');
  }
  if (typeof payload.deptId !== 'string' || payload.deptId.length === 0) {
    throw new Error('personnel.member.updated payload is missing deptId');
  }
  if (typeof envelope.eventTime !== 'string' || envelope.eventTime.length === 0) {
    throw new Error('personnel.member.updated envelope is missing eventTime');
  }
  return { eventTime: envelope.eventTime, eventType: envelope.eventType ?? '', payload };
}

/**
 * The fields the eligibility selector requires, seeded only where absent, so the first event
 * for a member (a role change for a brand-new chief, say) creates a snapshot the selector can
 * read instead of one it rejects on shape. Defaults match eligibilityChangedConsumer.
 */
const SNAPSHOT_DEFAULTS: ReadonlyArray<readonly [string, string, unknown]> = [
  ['active', ':defaultActive', true],
  ['availabilityState', ':defaultAvailability', 'AVAILABLE'],
  ['quals', ':emptyQuals', []],
  ['roles', ':emptyRoles', []],
];

/**
 * `roles` is a DynamoDB reserved word: used bare in an expression, the whole UpdateItem fails
 * with a ValidationException - so every member.updated event (each one seeds roles) was
 * retried into the DLQ and no push token, phone or role change ever reached the snapshot.
 * Every expression here names it through `#roles`.
 */
const ROLES_NAME = '#roles';
const ATTRIBUTE_NAMES = { [ROLES_NAME]: 'roles' } as const;

function expressionName(field: string): string {
  return field === 'roles' ? ROLES_NAME : field;
}

function seedDefaults(
  setClauses: string[],
  values: Record<string, unknown>,
  alreadySet: ReadonlySet<string>,
): void {
  for (const [field, placeholder, value] of SNAPSHOT_DEFAULTS) {
    if (!alreadySet.has(field)) {
      const name = expressionName(field);
      setClauses.push(`${name} = if_not_exists(${name}, ${placeholder})`);
      values[placeholder] = value;
    }
  }
}

/**
 * Each eligibility field has its own clock; no shared field guards anything (review
 * CRITICAL-1). `active` was guarded on the snapshot-wide snapshotUpdatedAt, which the
 * availability consumer also advances - so a retirement or LOA delivered after a newer
 * availability change (another queue, a retry, a DLQ redrive) was dropped as stale, and the
 * retired member kept getting SMS pages and voice calls.
 *  - active -> activeUpdatedAt;
 *  - availabilityState -> availabilityUpdatedAt (the availability consumer's clock too);
 *  - quals -> qualsUpdatedAt (eligibilityChangedConsumer's clock too).
 * snapshotUpdatedAt is only "last applied write" for the staleness report; it guards nothing.
 */
const FIELD_CLOCKS = [
  ['active', 'activeUpdatedAt'],
  ['availabilityState', 'availabilityUpdatedAt'],
  ['quals', 'qualsUpdatedAt'],
] as const;

function buildFieldExpressions(payload: MemberUpdatedPayload, eventTime: number) {
  return FIELD_CLOCKS.filter(([field]) => payload[field] !== undefined).map(([field, clock]) => {
    const setClauses = [
      'entityType = :entityType',
      'memberId = :memberId',
      `${field} = :value`,
      `${clock} = :eventTime`,
      'snapshotUpdatedAt = :eventTime',
    ];
    const values: Record<string, unknown> = {
      ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
      ':memberId': payload.memberId,
      ':value': payload[field],
      ':eventTime': eventTime,
    };
    seedDefaults(setClauses, values, new Set([field]));
    return {
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ConditionExpression: `attribute_not_exists(${clock}) OR ${clock} < :eventTime`,
      ExpressionAttributeNames: ATTRIBUTE_NAMES,
      ExpressionAttributeValues: values,
    };
  });
}

/**
 * Roles carry their own rolesUpdatedAt, as every field does: availability, push-token and
 * status events advance snapshotUpdatedAt on their own schedule, and guarding roles on it
 * silently discarded a role change whenever any newer unrelated event landed first - the new
 * officer was then never prompted for mutual aid, and re-saving the (unchanged) roles emitted
 * nothing that could repair it.
 */
function buildRolesExpression(roles: readonly string[], memberId: string, eventTime: number) {
  const setClauses = [
    'entityType = :entityType',
    'memberId = :memberId',
    `${ROLES_NAME} = :roles`,
    'rolesUpdatedAt = :rolesUpdatedAt',
    'snapshotUpdatedAt = if_not_exists(snapshotUpdatedAt, :rolesUpdatedAt)',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
    ':memberId': memberId,
    ':roles': roles,
    ':rolesUpdatedAt': eventTime,
  };
  seedDefaults(setClauses, values, new Set(['roles']));
  return {
    UpdateExpression: `SET ${setClauses.join(', ')}`,
    ConditionExpression: 'attribute_not_exists(rolesUpdatedAt) OR rolesUpdatedAt < :rolesUpdatedAt',
    ExpressionAttributeNames: ATTRIBUTE_NAMES,
    ExpressionAttributeValues: values,
  };
}

/**
 * The member's phone in E.164, or undefined. Personnel stores E.164; a number stored before it
 * did is normalised here, and one that cannot be parsed is not projected - an SMS vendor
 * refuses it on every page - but counted (InvalidPhoneSkipped) and logged, never silent.
 */
function projectablePhone(payload: MemberUpdatedPayload): string | null | undefined {
  if (payload.phone === null) {
    // The member's phone was cleared: their SMS and voice entries are removed.
    return null;
  }
  if (typeof payload.phone !== 'string' || payload.phone.trim().length === 0) {
    return undefined;
  }
  const phone = normalizePhoneE164(payload.phone);
  if (!phone) {
    console.error(
      JSON.stringify({
        event: 'alerting.eligibility.phone_invalid',
        service: 'alerting-service',
        correlationId: payload.memberId,
        memberId: payload.memberId,
      }),
    );
    emitOutcomeMetric(LATENCY_METRIC_NAMESPACE, 'InvalidPhoneSkipped');
  }
  return phone;
}

/** The contact groups this event carries, or undefined when it carries neither. */
function contactUpdateFrom(payload: MemberUpdatedPayload): ContactUpdate | undefined {
  const phone = projectablePhone(payload);
  const pushEntries = Array.isArray(payload.contactChannels)
    ? pushEntriesFrom(payload.contactChannels)
    : undefined;
  if (phone === undefined && pushEntries === undefined) {
    return undefined;
  }
  return {
    ...(pushEntries !== undefined ? { pushEntries } : {}),
    ...(phone !== undefined ? { phone } : {}),
  };
}

function logStale(memberId: string): void {
  console.log(
    JSON.stringify({
      event: 'alerting.eligibility.snapshot.stale_discarded',
      service: 'alerting-service',
      correlationId: memberId,
      memberId,
    }),
  );
  emitSnapshotMetric('Stale');
}

function logUpdateFailed(memberId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'alerting.eligibility.snapshot.update.failed',
      service: 'alerting-service',
      correlationId: memberId,
      memberId,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  emitSnapshotMetric('Failed');
}

function emitPropagationLatency(memberId: string, eventTimeMs: number): void {
  const latencyMs = Date.now() - eventTimeMs;
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
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const client = createDynamoClient(process.env);
  const tableName = readAlertingConfig(process.env).tableName;

  for (const record of event.Records) {
    const envelope = parseEnvelope(record.body);
    const { payload } = envelope;
    const deptId = toVerifiedDeptId({ deptId: payload.deptId });
    const pk = buildDeptScopedPk(deptId, 'ELIGIBILITY');
    const snapshotUpdatedAt = Date.parse(envelope.eventTime);
    const updates = [
      ...buildFieldExpressions(payload, snapshotUpdatedAt),
      payload.roles !== undefined
        ? buildRolesExpression(payload.roles, payload.memberId, snapshotUpdatedAt)
        : undefined,
    ].filter((update) => update !== undefined);

    for (const update of updates) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk, sk: `MEMBER#${payload.memberId}` },
            ...update,
          }),
        );
        emitSnapshotMetric('Updated');
        emitPropagationLatency(payload.memberId, snapshotUpdatedAt);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          logStale(payload.memberId);
          continue;
        }
        logUpdateFailed(payload.memberId, error);
        throw error;
      }
    }

    const contactUpdate = contactUpdateFrom(payload);
    if (contactUpdate) {
      try {
        const outcome = await applyContactUpdate(
          client,
          tableName,
          { pk, sk: `MEMBER#${payload.memberId}` },
          payload.memberId,
          contactUpdate,
          snapshotUpdatedAt,
        );
        if (outcome === 'stale') {
          logStale(payload.memberId);
        } else {
          emitSnapshotMetric('Updated');
          emitPropagationLatency(payload.memberId, snapshotUpdatedAt);
        }
      } catch (error) {
        logUpdateFailed(payload.memberId, error);
        throw error;
      }
    }
  }

  return { batchItemFailures: [] };
};
