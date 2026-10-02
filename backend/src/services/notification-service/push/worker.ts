import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { readPushSecretId, sendApns, sendFcm, type PushSendResult } from '@boxalarm/push-transport';
import AWSXRay from 'aws-xray-sdk-core';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  withTokenInvalidated,
  writePushDevices,
  type ContactChannelEntry,
} from '../../personnel-service/pushTokens/pushDevices.js';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import { logError } from '../log.js';
import {
  buildNonCriticalApnsPayload,
  buildNonCriticalFcmRequest,
  nonCriticalApnsHeaders,
  type NonCriticalPush,
} from './nonCriticalPush.js';

/**
 * The non-critical push worker (design review M7): SNS `boxalarm-{env}-notification-push` →
 * SQS → here. It resolves the target member's PUSH devices from the platform-table member row
 * (LOB may read LOB; the alerting plane's denormalized snapshot is not touched) and delivers
 * through the same APNs/FCM HTTP mechanics as the alerting worker (@boxalarm/push-transport),
 * but only ever in the non-critical shape nonCriticalPush.ts can express.
 *
 * Per-member category mutes are resolved BEFORE publish — the digest job and every immediate
 * consumer read NOTIFPREF and skip the publish for a muted member (digestJob.sendDigest,
 * apparatusDefectConsumer.deliverTo) — so a message that reaches this worker is already
 * mute-filtered and is sent to every valid device.
 *
 * `isTest` semantics do not apply here: this is never the page path and never a self-test, so
 * every send is hard-coded isTest: false (a configuration refusal dead-letters and alarms
 * rather than reporting a failed test).
 */

export const PUSH_WORKER_METRIC_NAMESPACE = 'Boxalarm/NotificationPush';
const LOG_PREFIX = 'notification.push';

/** Same per-request budget as the alerting channel workers; the Lambda timeout is 15s. */
export const PUSH_REQUEST_TIMEOUT_MS = 4_000;

/** One member's pushes per SQS record; a member has at most 10 devices (MAX_PUSH_DEVICES). */
export interface NotificationPushMessage {
  readonly deptId: string;
  readonly memberId: string;
  readonly title: string;
  readonly body: string;
  readonly notificationCategory: string;
  readonly correlationId: string;
}

class MalformedPushMessageError extends Error {}

function requireString(value: Record<string, unknown>, field: string): string {
  const parsed = value[field];
  if (typeof parsed !== 'string' || parsed.length === 0) {
    throw new MalformedPushMessageError(`notification push message is missing ${field}`);
  }
  return parsed;
}

/**
 * The SQS body is the published JSON (RawMessageDelivery). A body still wrapped in the SNS
 * envelope (a subscription created without raw delivery) is unwrapped rather than dropped.
 */
export function parsePushMessage(body: string): NotificationPushMessage {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new MalformedPushMessageError('notification push message is not JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new MalformedPushMessageError('notification push message is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.Type === 'Notification' && typeof record.Message === 'string') {
    return parsePushMessage(record.Message);
  }
  return {
    deptId: requireString(record, 'deptId'),
    memberId: requireString(record, 'memberId'),
    title: requireString(record, 'title'),
    body: requireString(record, 'body'),
    notificationCategory:
      typeof record.notificationCategory === 'string' && record.notificationCategory.length > 0
        ? record.notificationCategory
        : requireString(record, 'channelId'),
    correlationId:
      typeof record.correlationId === 'string' && record.correlationId.length > 0
        ? record.correlationId
        : requireString(record, 'memberId'),
  };
}

/**
 * PushCredentialsUnavailableError by shape, not instanceof: the transport package can be
 * instantiated more than once (bundler duplication, vitest module resets), and a terminal
 * "this secret is simply not configured" must not turn into an endless redelivery because the
 * class identity differs. The error sets its own `name` and `transient` for exactly this.
 */
function isNonTransientCredentialsUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'PushCredentialsUnavailableError' &&
    (error as { transient?: boolean }).transient !== true
  );
}

const APNS_DEVICE_TOKEN = /^[0-9a-f]{64}$/i;

/** Same resolution as the alerting worker: declared platform first, token shape as fallback. */
function resolvePlatform(entry: ContactChannelEntry, token: string): 'APNS' | 'FCM' {
  const normalized = entry.platform?.toUpperCase();
  if (normalized === 'APNS' || normalized === 'IOS') return 'APNS';
  if (normalized === 'FCM' || normalized === 'ANDROID') return 'FCM';
  return APNS_DEVICE_TOKEN.test(token) ? 'APNS' : 'FCM';
}

interface PushDevice {
  readonly entry: ContactChannelEntry;
  readonly token: string;
}

function pushDevices(item: Record<string, unknown> | undefined): PushDevice[] {
  const channels = (item?.contactChannels as readonly ContactChannelEntry[] | undefined) ?? [];
  return channels
    .filter(
      (entry) =>
        typeof entry?.channel === 'string' &&
        entry.channel.toUpperCase() === 'PUSH' &&
        entry.valid !== false &&
        typeof entry.token === 'string' &&
        entry.token.length > 0,
    )
    .map((entry) => ({ entry, token: entry.token as string }));
}

export interface PushWorkerDeps {
  readonly ddb?: DynamoDBDocumentClient;
  readonly secretsClient?: SecretsManagerClient;
  readonly sendApns?: typeof sendApns;
  readonly sendFcm?: typeof sendFcm;
  /** Test seams, handed through to the transport. */
  readonly apnsOrigin?: string;
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

let cachedSecretsClient: SecretsManagerClient | undefined;

function createSecretsClient(client?: SecretsManagerClient): SecretsManagerClient {
  cachedSecretsClient ??= client ?? AWSXRay.captureAWSv3Client(new SecretsManagerClient({}));
  return cachedSecretsClient;
}

/**
 * A dead token is corrected at its source: the personnel member row, through writePushDevices,
 * whose transaction also emits personnel.member.updated so the alerting snapshot follows.
 * Never silently — but also never fatally: the push was already refused terminally, so a
 * bookkeeping failure is logged and counted rather than dead-lettering the record.
 */
async function invalidateDeadToken(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  message: NotificationPushMessage,
  token: string,
  reason: string,
  invalidSinceMs?: number,
): Promise<void> {
  logError(
    `${LOG_PREFIX}.token_invalid`,
    new Error(reason),
    message.correlationId,
    { memberId: message.memberId }, // never the token
  );
  emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushTokenInvalid', reason);
  try {
    await writePushDevices(
      ddb,
      tableName,
      deptId,
      message.memberId,
      (current) => withTokenInvalidated(current, token, invalidSinceMs),
      {
        correlationId: message.correlationId,
        changedBy: { service: 'notification-service', cause: 'push_gateway_refusal', reason },
      },
    );
  } catch (error) {
    logError(`${LOG_PREFIX}.invalidate_failed`, error, message.correlationId, {
      memberId: message.memberId,
    });
    emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushTokenInvalidateFailed');
  }
}

async function sendToDevice(
  device: PushDevice,
  push: NonCriticalPush,
  env: NodeJS.ProcessEnv,
  deps: PushWorkerDeps,
  secretsClient: SecretsManagerClient,
): Promise<PushSendResult> {
  const platform = resolvePlatform(device.entry, device.token);
  // Never a test: this worker has no self-test/canary path, and isTest is what unlocks the
  // sandbox/validate-only behaviors — hard-coding false keeps this the plain delivery path.
  const isTest = false;
  if (platform === 'APNS') {
    const apnsEnvironment = device.entry.apnsEnvironment ?? 'production';
    const secretId = readPushSecretId('APNS', env, { isTest, apnsEnvironment });
    return (deps.sendApns ?? sendApns)(
      {
        token: device.token,
        headers: nonCriticalApnsHeaders(push, Date.now()),
        buildPayload: () => buildNonCriticalApnsPayload(push),
      },
      {
        secretId,
        sandboxSecret: apnsEnvironment === 'development',
        isTest,
        secretsClient,
        timeoutMs: PUSH_REQUEST_TIMEOUT_MS,
        ...(deps.apnsOrigin ? { origin: deps.apnsOrigin } : {}),
      },
    );
  }
  const secretId = readPushSecretId('FCM', env, { isTest });
  return (deps.sendFcm ?? sendFcm)(
    { buildRequest: () => buildNonCriticalFcmRequest(push, device.token, Date.now()) },
    {
      secretId,
      isTest,
      secretsClient,
      timeoutMs: PUSH_REQUEST_TIMEOUT_MS,
      ...(deps.fcmOrigin ? { fcmOrigin: deps.fcmOrigin } : {}),
      ...(deps.oauthTokenUrl ? { oauthTokenUrl: deps.oauthTokenUrl } : {}),
    },
  );
}

async function deliverRecord(
  body: string,
  env: NodeJS.ProcessEnv,
  deps: PushWorkerDeps,
): Promise<void> {
  const { tableName } = readNotificationConfig(env);
  const ddb = createDynamoClient(env, deps.ddb);
  const secretsClient = createSecretsClient(deps.secretsClient);
  const message = parsePushMessage(body);
  const deptId = toVerifiedDeptId({ deptId: message.deptId });

  const row = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', message.memberId), sk: 'METADATA' },
    }),
  );
  const devices = pushDevices(row.Item);
  if (devices.length === 0) {
    // Not an error: a member without the app still gets the inbox record and email.
    console.error(
      JSON.stringify({
        event: `${LOG_PREFIX}.no_devices`,
        service: 'notification-service',
        correlationId: message.correlationId,
        memberId: message.memberId,
      }),
    );
    emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushNoDevices');
    return;
  }

  const push: NonCriticalPush = {
    title: message.title,
    body: message.body,
    notificationCategory: message.notificationCategory,
    idempotencyKey: `${message.deptId}#${message.memberId}#${message.notificationCategory}#${message.correlationId}`,
  };

  let failed = 0;
  for (const device of devices) {
    let result: PushSendResult;
    try {
      result = await sendToDevice(device, push, env, deps, secretsClient);
    } catch (error) {
      if (isNonTransientCredentialsUnavailable(error)) {
        // The secret this device's environment needs is simply not configured: terminal for
        // the device (a redelivery gets the same answer), counted and alarmed, never silent.
        logError(`${LOG_PREFIX}.credentials_unavailable`, error, message.correlationId, {
          memberId: message.memberId,
          secretKey: (error as { secretKey?: string }).secretKey,
        });
        emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushCredentialsUnavailable');
        continue;
      }
      logError(`${LOG_PREFIX}.send_failed`, error, message.correlationId, {
        memberId: message.memberId,
      });
      failed += 1;
      continue;
    }
    if (result.outcome === 'sent') {
      emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushSent');
      continue;
    }
    if (result.outcome === 'invalid_token') {
      await invalidateDeadToken(
        ddb,
        tableName,
        deptId,
        message,
        device.token,
        result.reason,
        result.invalidSinceMs,
      );
      continue;
    }
    // test_refused is unreachable with isTest hard-coded false; a result this worker cannot
    // explain must stay loud rather than be dropped.
    throw new Error(`unexpected push send outcome ${result.outcome}`);
  }
  if (failed > 0) {
    emitOutcomeMetric(PUSH_WORKER_METRIC_NAMESPACE, 'PushSendFailed');
    throw new Error(`push delivery failed for ${failed} of ${devices.length} device(s)`);
  }
}

/**
 * SQS handler with per-record failure reporting: one member's retryable failure redelivers
 * only that record (and dead-letters after maxReceiveCount, alarmed), never the batch.
 */
export function createPushWorkerHandler(deps: PushWorkerDeps = {}) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await deliverRecord(record.body, process.env, deps);
      } catch (error) {
        logError(`${LOG_PREFIX}.record_failed`, error, record.messageId);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

export const handler = createPushWorkerHandler();
