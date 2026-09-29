import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import {
  parseChannelEnvelope,
  parseMutualAidPromptEnvelope,
  resolveChannelTarget,
  type ChannelEnvelopePayload,
  type ChannelName,
  type ContactChannelSnapshot,
  type MutualAidPromptPayload,
} from './channelEnvelope.js';
import { sendViaHttpProvider } from './httpProviderAdapter.js';
import { resolvePushPlatform, sendPush, type PushSendResult } from './push/pushProviderAdapter.js';
import type { PushAlertFields } from './push/pushPayload.js';
import { resolvePushTargets, type PushDeviceTarget } from '../eligibility/resolvePushTarget.js';
import { invalidatePushToken } from '../receipts/invalidatePushToken.js';
import {
  admitTokenInvalidation,
  MassTokenInvalidationError,
} from './push/massInvalidationGuard.js';

const METRIC_NAMESPACE = 'Boxalarm/AlertingChannel';

/**
 * A send guard moves CLAIMED -> SENT (provider accepted) or FAILED (provider refused, with
 * failureReason). A guard left CLAIMED means the attempt never finished: the worker died
 * mid-send, or the FAILED write itself failed. Guards written before sendState existed carry
 * none and are treated as sent, as they always were.
 */
const SEND_STATE_CLAIMED = 'CLAIMED';
const SEND_STATE_SENT = 'SENT';
const SEND_STATE_FAILED = 'FAILED';

/**
 * How old a CLAIMED guard must be before a redelivery may take it over. Longer than the
 * worker's 15s Lambda timeout (infrastructure DEFAULT_WORKER_TIMEOUT_SECONDS), so the
 * attempt that wrote it has certainly ended; shorter than the queue's 30s visibility
 * timeout, so the redelivery of a message whose worker died does qualify. A concurrent twin
 * - a re-publish of the same page - sees a fresh claim and is skipped as a duplicate.
 */
export const STALE_CLAIM_SECONDS = 20;

const CHANNEL_TIER: Record<ChannelName, 'primary' | 'escalation'> = {
  push: 'primary',
  sms: 'primary',
  voice: 'escalation',
};

interface DeliverChannelMessageCommon {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly contactChannels: readonly ContactChannelSnapshot[] | undefined;
  readonly message: string;
  /** Push notification title; the message is the body. SMS/voice send the message alone. */
  readonly title?: string;
  /** Push only: the dispatch's own fields, sent to the app as their own keys. */
  readonly alert?: PushAlertFields;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Self-test/canary message: labelled TEST; APNs on the device's own environment, FCM
   * validate_only with its sandbox credentials, SMS/voice with the sandbox vendor credentials.
   */
  readonly isTest?: boolean;
}

/**
 * A dispatch page is guarded per tone; a mutual-aid prompt carries no toneSequence and is
 * guarded in its own MAPROMPT# namespace (architecture §3.1 "Officer push item shape") so it
 * never collides with the tone-3 receipt an officer already holds.
 */
export type DeliverChannelMessageParams = DeliverChannelMessageCommon &
  (
    | { readonly alertKind?: 'dispatch'; readonly toneSequence: number }
    | { readonly alertKind: 'mutual_aid_prompt'; readonly toneSequence?: undefined }
  );

interface SendGuard {
  readonly sk: string;
  readonly idempotencyKey: string;
  readonly attributes: Record<string, unknown>;
}

function buildSendGuard(params: DeliverChannelMessageParams, sentAt: number): SendGuard {
  const { dispatchId, memberId, channel } = params;
  const channelUpper = channel.toUpperCase();
  if (params.alertKind === 'mutual_aid_prompt') {
    // Disjoint from the producer's MAPROMPT#{memberId}#PUSH record, which mutualAidPort writes
    // before publishing — sharing it would make this worker duplicate-skip every prompt.
    return {
      sk: `MAPROMPT#${memberId}#${channelUpper}#SEND`,
      idempotencyKey: `${dispatchId}#MUTUALAID#${memberId}#${channelUpper}#SEND`,
      attributes: { entityType: 'MUTUAL_AID_PROMPT_SEND' },
    };
  }
  const { toneSequence } = params;
  return {
    sk: `RECEIPT#${memberId}#${channelUpper}#${toneSequence}`,
    idempotencyKey: `${dispatchId}#${toneSequence}#${memberId}#${channelUpper}`,
    attributes: {
      entityType: 'DELIVERY_RECEIPT',
      channelTier: CHANNEL_TIER[channel],
      toneSequence,
      gsi1pk: `MEMBER#${memberId}`,
      gsi1sk: `RECEIPT#${sentAt}#${dispatchId}`,
    },
  };
}

export async function deliverChannelMessage(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
): Promise<void> {
  const { deptId, dispatchId, memberId, channel, contactChannels } = params;
  const isTest = params.isTest === true;
  const correlationId = dispatchId;
  const resolved = resolveChannelTarget(channel, contactChannels);
  if (resolved.skipped) {
    logInfo('alerting.channel.no_target', {
      correlationId,
      memberId,
      channel,
      reason: resolved.reason,
      isTest,
    });
    // A real page with no target is a member who was not reached, acknowledged with no DLQ
    // entry - NoTargetRegistered is alarmed per channel (design review C2). A self-test/canary
    // miss is reported through its own result, so it is counted apart.
    emitOutcomeMetric(
      METRIC_NAMESPACE,
      isTest ? 'TestNoTargetRegistered' : 'NoTargetRegistered',
      channel,
    );
    return;
  }

  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const sentAt = Math.floor(Date.now() / 1000);
  const { sk, idempotencyKey, attributes } = buildSendGuard(params, sentAt);
  let priorDeviceSends: DeviceSends = {};

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk,
          sk,
          ...attributes,
          dispatchId,
          memberId,
          deptId,
          channel: channel.toUpperCase(),
          sentAt,
          deliveredAt: null,
          openedAt: null,
          failureReason: null,
          sendState: SEND_STATE_CLAIMED,
          idempotencyKey,
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const retaken = await reattemptClaimedFailure(ddb, tableName, pk, sk, sentAt);
      if (!retaken) {
        logInfo('alerting.channel.duplicate_skipped', { correlationId, memberId, channel });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DuplicateSkipped', channel);
        return;
      }
      priorDeviceSends = retaken.deviceSends;
    } else {
      logError('alerting.channel.receipt_write_failed', error, {
        correlationId,
        memberId,
        channel,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'SendFailed', channel);
      throw error;
    }
  }

  const guard: GuardRef = { pk, sk, idempotencyKey };
  if (channel === 'push') {
    await deliverPushToDevices(ddb, tableName, params, guard, priorDeviceSends);
    return;
  }

  try {
    await sendViaHttpProvider(channel, resolved.target, params.message, params.env, { isTest });
  } catch (error) {
    await recordSendError(ddb, tableName, params, guard, error, {});
    return;
  }
  emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
  await recordSent(ddb, tableName, pk, sk);
}

interface GuardRef {
  readonly pk: string;
  readonly sk: string;
  readonly idempotencyKey: string;
}

/**
 * Per-device progress of one push page, on its per-channel send guard: SENT (the gateway
 * accepted it), INVALID (the token is dead), REFUSED (a self-test the provider refused for a
 * configuration reason). A redelivery after a transient failure skips the SENT and INVALID
 * devices, so a member's phone is not buzzed twice because their tablet's gateway call failed.
 */
type DeviceSendState = 'SENT' | 'INVALID' | 'REFUSED';
type DeviceSends = Record<string, DeviceSendState>;

/**
 * A failed provider send. A real page is recorded FAILED and rethrown so SQS redelivers it
 * (and dead-letters it, which pages on-call). A self-test/canary send the provider (sandbox)
 * refused is that run's FAIL - its result is read from this guard (evaluateSelfTestRun.ts);
 * redelivering it would only dead-letter a synthetic page and page on-call.
 */
async function recordSendError(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
  guard: GuardRef,
  error: unknown,
  deviceSends: DeviceSends,
): Promise<void> {
  const { channel, memberId, dispatchId } = params;
  const isTest = params.isTest === true;
  logError('alerting.channel.send_failed', error, {
    correlationId: dispatchId,
    memberId,
    channel,
    isTest,
  });
  emitOutcomeMetric(METRIC_NAMESPACE, isTest ? 'TestSendFailed' : 'SendFailed', channel);
  await recordClaimedFailure(ddb, tableName, guard.pk, guard.sk, error, deviceSends);
  if (!isTest) {
    throw error;
  }
}

/**
 * Multi-device push. The exactly-once key stays `{dispatchId}#{toneSequence}#{memberId}#push`:
 * one publish and one send guard per member per tone, as for every channel (routing and dedup
 * key on channel, never on a device). Within that guard the worker sends to EVERY valid device
 * the member has registered (resolvePushTargets) and records each device's outcome, so:
 *  - any device accepted -> SENT (the member was paged); dead devices are invalidated;
 *  - a transient failure on any device -> FAILED and rethrown; the redelivery re-sends only to
 *    the devices without an outcome;
 *  - every device dead -> FAILED, terminal (no redelivery), as for a single dead token.
 */
async function deliverPushToDevices(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  params: DeliverChannelMessageParams,
  guard: GuardRef,
  priorDeviceSends: DeviceSends,
): Promise<void> {
  const { deptId, dispatchId, memberId, channel } = params;
  const isTest = params.isTest === true;
  const correlationId = dispatchId;
  const deviceSends: DeviceSends = { ...priorDeviceSends };
  const pending = resolvePushTargets(params.contactChannels).filter(
    (device) =>
      deviceSends[device.deviceKey] !== 'SENT' && deviceSends[device.deviceKey] !== 'INVALID',
  );

  const outcomes = await Promise.allSettled(
    pending.map((device) => sendPushToDevice(params, device, guard.idempotencyKey)),
  );

  let transientError: unknown;
  let massInvalidationError: Error | undefined;
  const refusals: string[] = [];
  const invalidReasons: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const device = pending[index]!;
    if (outcome.status === 'rejected') {
      transientError ??= outcome.reason;
      logError('alerting.channel.device_send_failed', outcome.reason, {
        correlationId,
        memberId,
        channel,
        deviceKey: device.deviceKey,
        isTest,
      });
      continue;
    }
    const result = outcome.value;
    if (result.outcome === 'sent') {
      deviceSends[device.deviceKey] = 'SENT';
      continue;
    }
    if (result.outcome === 'test_refused') {
      // Self-test/canary refused for a configuration reason: recorded for the test result,
      // neither retried (it cannot succeed) nor allowed to touch the member's token.
      logInfo('alerting.channel.test_refused', {
        correlationId,
        memberId,
        channel,
        reason: result.reason,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'TestRefused', channel);
      deviceSends[device.deviceKey] = 'REFUSED';
      refusals.push(result.reason);
      continue;
    }
    // invalid_token - terminal for this device: retrying the token can never page it.
    logInfo('alerting.channel.token_invalid', {
      correlationId,
      memberId,
      channel,
      deviceKey: device.deviceKey,
      reason: result.reason,
      isTest,
    });
    // A self-test's rejection fails that test (the member sees it) but never disables a token or
    // feeds the paging misconfiguration alarm (TokenInvalid): a test must not change what real
    // pages do. A really dead token is invalidated by the next real page.
    emitOutcomeMetric(METRIC_NAMESPACE, isTest ? 'TestTokenInvalid' : 'TokenInvalid', channel);
    invalidReasons.push(result.reason);
    if (isTest) {
      deviceSends[device.deviceKey] = 'INVALID';
      continue;
    }
    try {
      await invalidateDeadToken(
        ddb,
        tableName,
        deptId,
        memberId,
        device.token,
        correlationId,
        result.invalidSinceMs,
      );
      deviceSends[device.deviceKey] = 'INVALID';
    } catch (error) {
      // The mass-invalidation latch held this token valid: the device stays without an
      // outcome, so the page throws, redelivers and dead-letters (pages on-call).
      massInvalidationError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  if (transientError !== undefined) {
    await recordSendError(ddb, tableName, params, guard, transientError, deviceSends);
    if (massInvalidationError !== undefined) {
      throw massInvalidationError;
    }
    return;
  }
  const anySent = Object.values(deviceSends).includes('SENT');
  if (massInvalidationError !== undefined) {
    await recordClaimedFailure(
      ddb,
      tableName,
      guard.pk,
      guard.sk,
      massInvalidationError,
      deviceSends,
    );
    throw massInvalidationError;
  }
  if (anySent) {
    emitOutcomeMetric(METRIC_NAMESPACE, 'Sent', channel);
    await recordSent(ddb, tableName, guard.pk, guard.sk, deviceSends);
    return;
  }
  // Nothing accepted it, and nothing is worth retrying: every device refused or dead.
  const terminal =
    refusals.length > 0
      ? new Error(`PUSH_TEST_REFUSED ${refusals[0]}`)
      : new Error(`PUSH_TOKEN_INVALID ${invalidReasons[0] ?? 'no device accepted the page'}`);
  await recordClaimedFailure(ddb, tableName, guard.pk, guard.sk, terminal, deviceSends);
}

/** One device's send: APNs/FCM directly (architecture §Alerting). */
function sendPushToDevice(
  params: DeliverChannelMessageParams,
  device: PushDeviceTarget,
  idempotencyKey: string,
): Promise<PushSendResult> {
  const { message, env, dispatchId } = params;
  const platform = resolvePushPlatform(device.platform, device.token);
  const isPrompt = params.alertKind === 'mutual_aid_prompt';
  return sendPush(
    {
      token: device.token,
      alertKind: isPrompt ? 'mutual_aid_prompt' : 'dispatch',
      dispatchId,
      toneSequence: isPrompt ? undefined : params.toneSequence,
      title: params.title ?? (isPrompt ? 'MUTUAL AID REQUESTED' : 'DISPATCH'),
      body: message,
      idempotencyKey,
      // Per-tone notification identity (architecture §5.1 B4): tone 2 never collapses into 1.
      collapseKey: isPrompt ? `${dispatchId}#MUTUALAID` : `${dispatchId}#${params.toneSequence}`,
      ...(params.alert ? { alert: params.alert } : {}),
      ...(params.isTest === true ? { isTest: true } : {}),
    },
    platform,
    env,
    {
      isTest: params.isTest === true,
      ...(device.apnsEnvironment ? { apnsEnvironment: device.apnsEnvironment } : {}),
    },
  );
}

async function invalidateDeadToken(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  token: string,
  correlationId: string,
  invalidSinceMs: number | undefined,
): Promise<void> {
  try {
    const outcome = await invalidatePushToken(ddb, tableName, deptId, memberId, token, {
      ...(invalidSinceMs !== undefined ? { invalidSinceMs } : {}),
      // Counted only when this token would really be invalidated (not a replaced or
      // re-registered one), right before the write.
      beforeInvalidate: () => admitTokenInvalidation(ddb, tableName, deptId, token),
    });
    logInfo('alerting.pushToken.invalidated_by_send', { correlationId, memberId, outcome });
  } catch (error) {
    if (error instanceof MassTokenInvalidationError) {
      // A burst of rejected tokens reads as a gateway misconfiguration, not dead devices. This
      // token stays valid, and so does every later one while the guard's latch holds. Throw
      // so the page redelivers, dead-letters and pages on-call.
      logError('alerting.pushToken.mass_invalidation_blocked', error, { correlationId, memberId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'MassInvalidationBlocked', 'push');
      throw error;
    }
    // The guard could not decide, or the write failed: the token stays valid (a wasted send
    // later beats disabling a live device). The page already failed terminally.
    logError('alerting.pushToken.invalidate_failed', error, { correlationId, memberId });
  }
}

async function reattemptClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  sentAt: number,
): Promise<{ readonly deviceSends: DeviceSends } | undefined> {
  // Strongly consistent: a failure recorded moments ago must not read as a clean claim.
  const existing = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
  );
  const item = existing.Item;
  if (!item || item.deliveredAt != null) {
    return undefined;
  }
  const claimedButFailed = item.failureReason != null;
  // Review MINOR-R5: a worker killed mid-send, or whose failureReason write was throttled,
  // left a claim with no failure recorded - and every redelivery skipped it as a duplicate,
  // so that member was never paged on this channel.
  const claimAbandoned =
    item.sendState === SEND_STATE_CLAIMED &&
    typeof item.sentAt === 'number' &&
    item.sentAt < sentAt - STALE_CLAIM_SECONDS;
  if (!claimedButFailed && !claimAbandoned) {
    return undefined;
  }
  // Re-claims atomically: the condition requires the state that was just read - the failure
  // still recorded, or the same abandoned claim - so when two redeliveries both saw it only
  // one wins the re-claim and sends; the other is treated as a duplicate.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET sentAt = :sentAt, sendState = :claimed REMOVE failureReason',
        ConditionExpression: claimedButFailed
          ? 'attribute_exists(idempotencyKey) AND attribute_exists(failureReason) AND deliveredAt = :nullVal'
          : 'attribute_exists(idempotencyKey) AND sendState = :claimed AND sentAt = :observedSentAt AND deliveredAt = :nullVal',
        ExpressionAttributeValues: {
          ':sentAt': sentAt,
          ':claimed': SEND_STATE_CLAIMED,
          ':nullVal': null,
          ...(claimedButFailed ? {} : { ':observedSentAt': item.sentAt as number }),
        },
      }),
    );
    if (claimAbandoned) {
      logInfo('alerting.channel.abandoned_claim_retaken', { pk, sk });
    }
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return undefined;
    }
    throw error;
  }
  const deviceSends =
    typeof item.deviceSends === 'object' && item.deviceSends !== null
      ? (item.deviceSends as DeviceSends)
      : {};
  return { deviceSends };
}

async function recordClaimedFailure(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  error: unknown,
  deviceSends?: DeviceSends,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        UpdateExpression: `SET failureReason = :reason, sendState = :failed, completedAtMs = :completedAtMs${
          deviceSends ? ', deviceSends = :deviceSends' : ''
        }`,
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: {
          ':reason': error instanceof Error ? error.message : String(error),
          ':failed': SEND_STATE_FAILED,
          ':completedAtMs': Date.now(),
          ...(deviceSends ? { ':deviceSends': deviceSends } : {}),
        },
      }),
    );
  } catch (updateError) {
    logError('alerting.channel.failure_reason_write_failed', updateError, { pk, sk });
  }
}

/**
 * Marks the guard SENT so it is never taken over as abandoned, and is what a self-test/canary
 * run passes on. A failed write is only logged:
 * the page went out, and the worst case is one duplicate send after the stale window - for a
 * page, a duplicate is the safe side of a miss.
 */
async function recordSent(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
  deviceSends?: DeviceSends,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        // completedAtMs: when the provider accepted it - the end of a self-test/canary run's
        // ingress-to-delivery latency (selfTest/evaluateSelfTestRun.ts).
        UpdateExpression: `SET sendState = :sent, completedAtMs = :completedAtMs${
          deviceSends ? ', deviceSends = :deviceSends' : ''
        }`,
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeValues: {
          ':sent': SEND_STATE_SENT,
          ':completedAtMs': Date.now(),
          ...(deviceSends ? { ':deviceSends': deviceSends } : {}),
        },
      }),
    );
  } catch (error) {
    logError('alerting.channel.sent_state_write_failed', error, { pk, sk });
  }
}

export function createChannelWorkerHandler(
  channel: ChannelName,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const { tableName } = readAlertingConfig(process.env);
    const ddb = createDynamoClient(process.env);

    async function processRecord(record: SQSEvent['Records'][number]): Promise<void> {
      let envelope: ChannelEnvelopePayload | MutualAidPromptPayload;
      try {
        envelope =
          parseMutualAidPromptEnvelope(record.body, channel) ??
          parseChannelEnvelope(record.body, channel);
      } catch (error) {
        logError('alerting.channel.malformed_event', error, {
          correlationId: record.messageId,
          channel,
        });
        throw error;
      }

      const deptId = toVerifiedDeptId({ deptId: envelope.deptId });
      let contactChannels: ContactChannelSnapshot[] | undefined;
      try {
        const snapshot = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'),
              sk: `MEMBER#${envelope.memberId}`,
            },
          }),
        );
        contactChannels = snapshot.Item?.contactChannels as ContactChannelSnapshot[] | undefined;
      } catch (error) {
        logError('alerting.channel.eligibility_read_failed', error, {
          correlationId: envelope.dispatchId,
          memberId: envelope.memberId,
          channel,
        });
        throw error;
      }

      const common = {
        deptId,
        dispatchId: envelope.dispatchId,
        memberId: envelope.memberId,
        channel,
        contactChannels,
        env: process.env,
        isTest: envelope.isTest,
        alert: {
          incidentType: envelope.incidentType,
          address: envelope.address,
          ...(envelope.crossStreets ? { crossStreets: envelope.crossStreets } : {}),
          ...(envelope.dispatchedAt !== undefined ? { dispatchedAt: envelope.dispatchedAt } : {}),
        },
      };
      const incidentText = `${envelope.incidentType} — ${envelope.address}`;
      await deliverChannelMessage(
        ddb,
        tableName,
        'alertKind' in envelope
          ? {
              ...common,
              alertKind: 'mutual_aid_prompt',
              title: 'MUTUAL AID REQUESTED',
              message: `MUTUAL AID REQUESTED — ${incidentText}`,
            }
          : {
              ...common,
              toneSequence: envelope.toneSequence,
              title: envelope.incidentType,
              message: incidentText,
            },
      );
    }

    const results = await Promise.allSettled(event.Records.map(processRecord));
    const batchItemFailures = results
      .map((result, index) =>
        result.status === 'rejected'
          ? { itemIdentifier: event.Records[index]?.messageId ?? '' }
          : null,
      )
      .filter((failure): failure is { itemIdentifier: string } => failure !== null);

    return { batchItemFailures };
  };
}
