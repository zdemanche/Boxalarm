import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from './dynamoClient.js';
import { applyContactUpdate, pushEntriesFrom, type ContactUpdate } from './contactProjection.js';

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
 * The eligibility fields (active, quals, availabilityState), guarded on the snapshot-wide
 * snapshotUpdatedAt. Roles and contact channels have their own guarded writes. Undefined when
 * the event carries none of these fields.
 */
function buildMergeExpression(payload: MemberUpdatedPayload, snapshotUpdatedAt: number) {
  const setClauses = [
    'entityType = :entityType',
    'memberId = :memberId',
    'snapshotUpdatedAt = :snapshotUpdatedAt',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'MEMBER_ELIGIBILITY_SNAPSHOT',
    ':memberId': payload.memberId,
    ':snapshotUpdatedAt': snapshotUpdatedAt,
  };
  const set = new Set<string>();
  const assign = (field: keyof MemberUpdatedPayload, value: unknown) => {
    if (value !== undefined) {
      setClauses.push(`${field} = :${field}`);
      values[`:${field}`] = value;
      set.add(field);
    }
  };
  assign('active', payload.active);
  assign('quals', payload.quals);
  assign('availabilityState', payload.availabilityState);
  if (set.size === 0) {
    return undefined;
  }
  seedDefaults(setClauses, values, set);
  return {
    UpdateExpression: `SET ${setClauses.join(', ')}`,
    ConditionExpression:
      'attribute_not_exists(snapshotUpdatedAt) OR snapshotUpdatedAt < :snapshotUpdatedAt',
    ExpressionAttributeNames: ATTRIBUTE_NAMES,
    ExpressionAttributeValues: values,
  };
}

/**
 * Roles carry their own rolesUpdatedAt, as quals carry qualsUpdatedAt: availability, push-token
 * and status events advance snapshotUpdatedAt on their own schedule, and guarding roles on it
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

/** The contact groups this event carries, or undefined when it carries neither. */
function contactUpdateFrom(payload: MemberUpdatedPayload): ContactUpdate | undefined {
  const phone =
    typeof payload.phone === 'string' && payload.phone.trim().length > 0
      ? payload.phone.trim()
      : undefined;
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
      buildMergeExpression(payload, snapshotUpdatedAt),
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
