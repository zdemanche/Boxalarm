import { randomUUID } from 'node:crypto';
import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  getMemberEligibility,
  queryEligibleMembers,
  type EligibilitySnapshotItem,
} from '../eligibility/selector.js';
import { resolvePushTarget, resolveSmsTarget } from '../eligibility/resolvePushTarget.js';
import { buildChannelPagePayload, type TestDelivery } from '../channels/channelEnvelope.js';
import { getSchedulerClient } from '../escalation/scheduleEscalation.js';
import { scheduleRealtimeFanOutEscalation } from './fanOut.js';
import {
  SELF_TEST_METRIC_NAMESPACE,
  recordSelfTestFanOut,
  type SelfTestChannelResult,
} from '../selfTest/selfTestRunRepository.js';
import {
  deriveFanOutKey,
  deriveMessageDeduplicationId,
  type FanOutChannel,
  type FanOutKeyInput,
} from './idempotencyKey.js';
import { createSnsClient, readFanOutTopicConfig } from './snsClient.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-fan-out';
const TONE_SEQUENCE = 1;
const FAN_OUT_CHANNELS: readonly FanOutChannel[] = ['push', 'sms'];
const CHANNEL_TIER = 'primary';
const MAX_CONCURRENT_FANOUT_TASKS = 10;
const TEST_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365;

interface DispatchAlertRecord {
  readonly dispatchId: string;
  readonly deptId: VerifiedDeptId;
  readonly incidentType: string | undefined;
  readonly address: string | undefined;
  readonly crossStreets: string | undefined;
  readonly narrative: string | undefined;
  readonly mapLink: string | undefined;
  readonly isTest: boolean;
  readonly sourceSystem: string | undefined;
  readonly targetMemberId: string | undefined;
  readonly selfTestId: string | undefined;
  readonly channelsTested: readonly string[] | undefined;
  readonly dispatchedAt: number | undefined;
  readonly testDelivery: TestDelivery | undefined;
  /** RAW (fail-open) CAD dispatch: pages carry the dispatch text (channelEnvelope.ts). */
  readonly verifyRequired: boolean;
}

interface FanOutTask {
  readonly memberId: string;
  readonly channel: FanOutChannel;
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

function logInfo(event: string, correlationId: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      event,
      service: 'alerting-service',
      correlationId,
      ...extra,
    }),
  );
}

export async function runWithConcurrencyLimit<T>(
  tasks: readonly T[],
  limit: number,
  fn: (task: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  for (let offset = 0; offset < tasks.length; offset += limit) {
    const chunk = tasks.slice(offset, offset + limit);
    results.push(...(await Promise.allSettled(chunk.map(fn))));
  }
  return results;
}

function parseDispatchAlertRecord(record: DynamoDBRecord): DispatchAlertRecord | undefined {
  if (record.eventName !== 'INSERT') {
    return undefined;
  }
  const image = record.dynamodb?.NewImage;
  if (!image) {
    return undefined;
  }
  const item = unmarshall(image as Record<string, never>) as Record<string, unknown>;
  if (item.entityType !== 'DISPATCH_ALERT') {
    return undefined;
  }
  const dispatchId = item.dispatchId;
  const deptIdRaw = item.deptId;
  if (typeof dispatchId !== 'string' || typeof deptIdRaw !== 'string') {
    throw new Error('DISPATCH_ALERT stream record failed shape validation');
  }
  return {
    dispatchId,
    deptId: toVerifiedDeptId({ deptId: deptIdRaw }),
    incidentType: typeof item.incidentType === 'string' ? item.incidentType : undefined,
    address: typeof item.address === 'string' ? item.address : undefined,
    crossStreets: typeof item.crossStreets === 'string' ? item.crossStreets : undefined,
    narrative: typeof item.narrative === 'string' ? item.narrative : undefined,
    mapLink: typeof item.mapLink === 'string' ? item.mapLink : undefined,
    isTest: item.isTest === true,
    sourceSystem: typeof item.sourceSystem === 'string' ? item.sourceSystem : undefined,
    targetMemberId: typeof item.targetMemberId === 'string' ? item.targetMemberId : undefined,
    selfTestId: typeof item.selfTestId === 'string' ? item.selfTestId : undefined,
    channelsTested: Array.isArray(item.channelsTested)
      ? (item.channelsTested as string[])
      : undefined,
    dispatchedAt: typeof item.dispatchedAt === 'number' ? item.dispatchedAt : undefined,
    testDelivery:
      item.testDelivery === 'deliver' || item.testDelivery === 'validate'
        ? item.testDelivery
        : undefined,
    verifyRequired: item.verifyRequired === true,
  };
}

function buildDispatchNormalizedEnvelope(
  dispatch: DispatchAlertRecord,
  task: FanOutTask,
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventTime: new Date().toISOString(),
    eventType: 'alerting.dispatch.normalized',
    source: 'alert-fanout-service',
    correlationId: dispatch.dispatchId,
    schemaVersion: '1.0',
    payload: buildChannelPagePayload({
      deptId: dispatch.deptId,
      dispatchId: dispatch.dispatchId,
      memberId: task.memberId,
      channel: task.channel,
      channelTier: CHANNEL_TIER,
      toneSequence: TONE_SEQUENCE,
      dispatch,
    }),
  };
}

async function sendOne(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  dispatch: DispatchAlertRecord,
  task: FanOutTask,
  firstPass = false,
): Promise<void> {
  const keyInput: FanOutKeyInput = {
    dispatchId: dispatch.dispatchId,
    toneSequence: TONE_SEQUENCE,
    memberId: task.memberId,
    channel: task.channel,
  };
  const { sk, idempotencyKey } = deriveFanOutKey(keyInput);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId),
                sk,
                entityType: 'DELIVERY_RECEIPT',
                dispatchId: dispatch.dispatchId,
                memberId: task.memberId,
                deptId: dispatch.deptId,
                channel: task.channel,
                channelTier: CHANNEL_TIER,
                toneSequence: TONE_SEQUENCE,
                isTest: dispatch.isTest,
                idempotencyKey,
                ...(dispatch.isTest
                  ? { ttl: Math.floor(Date.now() / 1000) + TEST_AUDIT_TTL_SECONDS }
                  : {
                      gsi1pk: `MEMBER#${task.memberId}`,
                      gsi1sk: `RECEIPT#${Math.floor(Date.now() / 1000)}#${dispatch.dispatchId}`,
                    }),
              },
              ConditionExpression: 'attribute_not_exists(idempotencyKey)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellation = asTransactionCancellation(error);
    if (cancellation?.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed') {
      logError('fanout.receipt_write_failed', error, dispatch.dispatchId, {
        memberId: task.memberId,
        channel: task.channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'ReceiptWriteFailed');
      throw error;
    }
    const existing = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
      }),
    );
    if (existing.Item?.sentAt) {
      logInfo('fanout.receipt.duplicate_skipped', dispatch.dispatchId, {
        memberId: task.memberId,
        channel: task.channel,
        firstPass,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped');
      if (firstPass) {
        // On a retry a skip is expected (the earlier attempt sent this one). On the dispatch's
        // FIRST fan-out attempt nothing of ours can have written this receipt yet, so another
        // writer pre-empted the tone-1 page under its exactly-once key - the C1 defect shape,
        // where the member is not paged until tone 2. Alarmed (DuplicateSkippedFirstPass).
        logError(
          'fanout.receipt.duplicate_on_first_pass',
          new Error('tone-1 receipt already sent before the first fan-out attempt'),
          dispatch.dispatchId,
          { memberId: task.memberId, channel: task.channel },
        );
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkippedFirstPass', task.channel);
      }
      return;
    }
  }

  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(buildDispatchNormalizedEnvelope(dispatch, task)),
        MessageGroupId: dispatch.dispatchId,
        MessageDeduplicationId: deriveMessageDeduplicationId(keyInput),
        MessageAttributes: {
          channel: { DataType: 'String', StringValue: task.channel },
          channelTier: { DataType: 'String', StringValue: CHANNEL_TIER },
          toneSequence: { DataType: 'Number', StringValue: String(TONE_SEQUENCE) },
          isTest: { DataType: 'String', StringValue: String(dispatch.isTest) },
        },
      }),
    );
  } catch (error) {
    logError('fanout.publish_failed', error, dispatch.dispatchId, {
      memberId: task.memberId,
      channel: task.channel,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'SnsUnavailable');
    await ddb
      .send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
          UpdateExpression: 'SET failureReason = :reason',
          ExpressionAttributeValues: {
            ':reason': error instanceof Error ? error.constructor.name : 'UnknownError',
          },
        }),
      )
      .catch((updateError) => {
        logError('fanout.receipt_failure_annotation_failed', updateError, dispatch.dispatchId, {
          memberId: task.memberId,
          channel: task.channel,
        });
      });
    throw error;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId), sk },
      UpdateExpression: 'SET sentAt = :sentAt REMOVE failureReason',
      ExpressionAttributeValues: { ':sentAt': Math.floor(Date.now() / 1000) },
    }),
  );

  emitOutcomeMetric(METRIC_NAMESPACE, 'PublishAccepted');
}

interface PlannedFanOut {
  readonly tasks: readonly FanOutTask[];
  /** Channels a member could not be published on, keyed `${memberId}#${CHANNEL}`. */
  readonly skipped: ReadonlyMap<string, string>;
}

/**
 * Which member x channel pages to publish. Push and SMS each need the target the worker will
 * resolve (the same lookup, resolvePushTarget.ts); a member without one is skipped and counted
 * instead of published and dropped at the worker. A self-test/canary counts its skips in its
 * own namespace, so a canary member without a phone never trips the paging SmsSkipped alarm.
 */
function planFanOut(
  dispatch: DispatchAlertRecord,
  members: readonly EligibilitySnapshotItem[],
): PlannedFanOut {
  const isSelfTest = dispatch.targetMemberId !== undefined;
  const tasks: FanOutTask[] = [];
  const skipped = new Map<string, string>();
  for (const member of members) {
    for (const channel of FAN_OUT_CHANNELS) {
      // SMS: publishing a page the worker cannot resolve would be dropped there as
      // NoTargetRegistered. Skipped here it is counted and alarmed (SmsSkipped) instead.
      const target =
        channel === 'push'
          ? resolvePushTarget(member.contactChannels)
          : resolveSmsTarget(member.contactChannels);
      if (target.skipped) {
        const metric = channel === 'push' ? 'PushSkipped' : 'SmsSkipped';
        logInfo(`fanout.${channel}.skipped`, dispatch.dispatchId, {
          memberId: member.memberId,
          reason: target.reason,
          isSelfTest,
        });
        if (isSelfTest) {
          emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelFailed', metric);
        } else {
          emitOutcomeMetric(METRIC_NAMESPACE, metric);
        }
        skipped.set(`${member.memberId}#${channel.toUpperCase()}`, target.reason);
        continue;
      }
      tasks.push({ memberId: member.memberId, channel });
    }
  }
  return { tasks, skipped };
}

/**
 * The audience: every eligible member for a real dispatch; for a self-test/canary dispatch, the
 * one targeted member (eligible or not - the run reports why a real page would miss them).
 */
async function resolveAudience(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  dispatch: DispatchAlertRecord,
): Promise<readonly EligibilitySnapshotItem[]> {
  if (dispatch.targetMemberId === undefined) {
    return queryEligibleMembers(ddb, tableName, dispatch.deptId);
  }
  const member = await getMemberEligibility(
    ddb,
    tableName,
    dispatch.deptId,
    dispatch.targetMemberId,
  );
  return member ? [member] : [];
}

/**
 * The single fan-out path, for real dispatches and for self-test/canary dispatches alike
 * (architecture §1.3: "a canary that tests a parallel, simplified path is a canary that lies").
 * A test differs only in its audience (one member), in never scheduling escalation or the tone
 * ladder, and in recording its run for evaluateSelfTestRun instead of failing the stream record.
 */
async function fanOutOneDispatch(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  scheduler: SchedulerClient,
  tableName: string,
  topicArn: string,
  dispatch: DispatchAlertRecord,
): Promise<void> {
  const fanOutStartedMs = Date.now();
  const isSelfTest = dispatch.targetMemberId !== undefined;

  try {
    const audience = await resolveAudience(ddb, tableName, dispatch);

    // fanOutAttempts tells the first attempt from a stream retry, so a duplicate on the first
    // pass (another writer pre-empted tone 1) can be alarmed without paging on every retry.
    const started = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: buildDeptScopedPk(dispatch.deptId, 'DISPATCH', dispatch.dispatchId),
          sk: 'METADATA',
        },
        UpdateExpression:
          'SET fanOutStartedAt = :startedAt, eligibleMemberCount = :count, fanOutAttempts = if_not_exists(fanOutAttempts, :zero) + :one',
        ExpressionAttributeValues: {
          ':startedAt': Math.floor(fanOutStartedMs / 1000),
          ':count': audience.length,
          ':zero': 0,
          ':one': 1,
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const firstPass = started?.Attributes?.fanOutAttempts === 1;

    const { tasks, skipped } = planFanOut(dispatch, audience);

    if (!isSelfTest) {
      // Alarmed below a department minimum (design review M6): a deptId mismatch, a dead
      // eligibility consumer or a mass mark-off all look like "paged nobody" and nothing else.
      emitEmf(METRIC_NAMESPACE, 'EligibleMemberCount', audience.length, [[]]);
    }
    if (tasks.length === 0 && !isSelfTest) {
      // Nobody could be paged on any channel. Alarmed.
      logError('fanout.empty_roster', new Error('no member could be paged'), dispatch.dispatchId, {
        eligibleMemberCount: audience.length,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'EmptyRoster');
      if (audience.length === 0) {
        return;
      }
      // Eligible members exist but none was reachable now. The roster and the tone ladder are
      // still scheduled: tones 2/3 re-resolve targets, so a member whose device registers or
      // whose phone lands in the next minutes is paged then (review MINOR-6).
    }

    const results = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_FANOUT_TASKS, (task) =>
      sendOne(ddb, sns, tableName, topicArn, dispatch, task, firstPass),
    );

    if (isSelfTest) {
      await recordSelfTestPublished(ddb, tableName, dispatch, audience[0], tasks, results, skipped);
      return;
    }

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    let schedulingError: Error | undefined;
    try {
      await scheduleRealtimeFanOutEscalation(
        ddb,
        scheduler,
        tableName,
        dispatch.deptId,
        dispatch.dispatchId,
        audience.map((member) => ({ memberId: member.memberId, quals: member.quals })),
      );
    } catch (error) {
      schedulingError = error instanceof Error ? error : new Error(String(error));
      logError('fanout.escalation_schedule_failed', error, dispatch.dispatchId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'EscalationScheduleFailed');
    }

    if (failures.length > 0) {
      throw failures[0]!.reason;
    }
    if (schedulingError) {
      throw schedulingError;
    }
  } finally {
    emitEmf(METRIC_NAMESPACE, 'FanOutLatencyMs', Date.now() - fanOutStartedMs, [[]]);
  }
}

function eligibilityReasonFor(member: EligibilitySnapshotItem): string | undefined {
  if (!member.active) {
    return 'member is inactive — a real dispatch would not page you';
  }
  return member.availabilityState !== 'AVAILABLE'
    ? `member is ${member.availabilityState} — a real dispatch would not page you`
    : undefined;
}

/**
 * The fan-out's record of a self-test/canary run: what was published, and why anything was
 * not. It never decides PASS - a published page passes only when its worker records it SENT
 * (selfTest/evaluateSelfTestRun.ts). It never throws either: a self-test is not retried by
 * stream redrive, its failure is reported to the member.
 */
async function recordSelfTestPublished(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  dispatch: DispatchAlertRecord,
  member: EligibilitySnapshotItem | undefined,
  tasks: readonly FanOutTask[],
  results: readonly PromiseSettledResult<void>[],
  skipped: ReadonlyMap<string, string>,
): Promise<void> {
  const memberId = dispatch.targetMemberId!;
  const runAt = Math.floor(Date.now() / 1000);
  const testId = dispatch.selfTestId ?? String(runAt);
  const channelsTested = dispatch.channelsTested ?? FAN_OUT_CHANNELS.map((c) => c.toUpperCase());

  const channelResults: Record<string, SelfTestChannelResult> = {};
  const publishedChannels: string[] = [];
  if (!member) {
    logInfo('fanout.selfTest.memberNotFound', dispatch.dispatchId, { memberId, testId });
    for (const channel of channelsTested) {
      channelResults[channel] = { ok: false, ms: 0, reason: 'member not found' };
    }
  }
  for (const [key, reason] of skipped) {
    channelResults[key.split('#')[1]!] = { ok: false, ms: 0, reason };
  }
  tasks.forEach((task, index) => {
    const channel = task.channel.toUpperCase();
    const result = results[index];
    if (result?.status === 'fulfilled') {
      publishedChannels.push(channel);
      return;
    }
    const error: unknown = result?.reason;
    logError('fanout.selfTest.channelFailed', error, dispatch.dispatchId, { memberId, channel });
    emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestChannelFailed', 'SendFailed');
    channelResults[channel] = {
      ok: false,
      ms: 0,
      reason: `send failed (${error instanceof Error ? error.constructor.name : 'UnknownError'})`,
    };
  });

  const eligibilityReason = member
    ? eligibilityReasonFor(member)
    : 'member not found — no eligibility snapshot';
  await recordSelfTestFanOut(ddb, tableName, {
    deptId: dispatch.deptId,
    memberId,
    testId,
    runAt,
    dispatchId: dispatch.dispatchId,
    channelsTested,
    publishedChannels,
    channelResults,
    ...(eligibilityReason ? { eligibilityReason } : {}),
    nowMs: Date.now(),
  });
  if (publishedChannels.length === 0) {
    emitOutcomeMetric(SELF_TEST_METRIC_NAMESPACE, 'SelfTestFailed');
  }
}

function recordItemIdentifier(record: DynamoDBRecord): string {
  return record.dynamodb?.SequenceNumber ?? record.eventID ?? 'unknown';
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const { tableName } = readAlertingConfig(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const scheduler = getSchedulerClient();

  for (const record of event.Records) {
    let dispatch: DispatchAlertRecord | undefined;
    try {
      dispatch = parseDispatchAlertRecord(record);
    } catch (error) {
      logError('fanout.malformed_record', error, record.eventID ?? 'unknown');
      return { batchItemFailures: [{ itemIdentifier: recordItemIdentifier(record) }] };
    }
    if (!dispatch) {
      continue;
    }
    try {
      await fanOutOneDispatch(ddb, sns, scheduler, tableName, topicArn, dispatch);
    } catch (error) {
      logError('fanout.dispatch_failed', error, dispatch.dispatchId);
      return { batchItemFailures: [{ itemIdentifier: recordItemIdentifier(record) }] };
    }
  }

  return { batchItemFailures: [] };
};
