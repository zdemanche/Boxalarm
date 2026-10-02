import type { OutgoingHttpHeaders } from 'node:http2';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  APNS_PRODUCTION_ORIGIN,
  APNS_SANDBOX_ORIGIN,
  http2Transport,
  type Http2Transport,
} from './http2.js';
import {
  apnsProviderToken,
  evictPushCredentials,
  loadApnsCredentials,
  PushProviderAuthError,
  type ApnsCredentials,
} from './pushCredentials.js';
import {
  isNonRetryableRefusal,
  nextRequestTimeout,
  PUSH_SEND_BUDGET_REQUESTS,
  type PushSendResult,
} from './pushResult.js';

/**
 * One APNs send, payload-agnostic. The caller owns everything notification-shaped: the
 * `apns-*` request headers (push type, priority, expiration, id, collapse id) and the payload.
 * `buildPayload` runs per attempt, after the credentials are read, because the payload may
 * depend on them (the alerting plane takes its interruption level from the APNs secret).
 */
export interface ApnsMessage {
  readonly token: string;
  /** Caller-owned `apns-*` headers; `:path`, `authorization`, `apns-topic` are added here. */
  readonly headers: Readonly<Record<string, string>>;
  readonly buildPayload: (credentials: ApnsCredentials) => Record<string, unknown>;
}

export interface SendApnsOptions {
  readonly secretId: string;
  /** The secret is the sandbox (development-environment) one: always the sandbox host. */
  readonly sandboxSecret?: boolean;
  /** A self-test/canary push: configuration refusals are a failed test, not a retried page. */
  readonly isTest: boolean;
  readonly secretsClient: SecretsManagerClient;
  readonly timeoutMs: number;
  readonly transport?: Http2Transport;
  /** Test seam: replaces the Apple host (a local HTTP/2 server). */
  readonly origin?: string;
}

interface ApnsErrorBody {
  readonly reason?: string;
  /** 410 only: epoch ms at which APNs confirmed the token was no longer valid. */
  readonly timestamp?: number;
}

function parseApnsError(body: string): ApnsErrorBody {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; timestamp?: unknown };
    return {
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      ...(typeof parsed.timestamp === 'number' ? { timestamp: parsed.timestamp } : {}),
    };
  } catch {
    return {};
  }
}

const APNS_AUTH_FAILURES = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
  'MissingProviderToken',
]);

/**
 * Token-based (.p8) APNs send over HTTP/2. 200 → sent; 410 or BadDeviceToken → the token is
 * dead (invalid_token, not retried); anything else throws so SQS redelivers and the caller's
 * re-claim path re-attempts. A provider-credential refusal evicts the cached secret and token
 * and is retried once in-process with freshly read credentials, so a key rotation costs one
 * extra round trip rather than a dead-lettered send.
 */
export async function sendApns(
  message: ApnsMessage,
  options: SendApnsOptions,
): Promise<PushSendResult> {
  const deadlineMs = Date.now() + PUSH_SEND_BUDGET_REQUESTS * options.timeoutMs;
  try {
    return await sendApnsOnce(message, options, deadlineMs);
  } catch (error) {
    if (!(error instanceof PushProviderAuthError)) throw error;
    evictPushCredentials(options.secretId, error);
    try {
      return await sendApnsOnce(message, options, deadlineMs);
    } catch (retryError) {
      if (!(retryError instanceof PushProviderAuthError)) throw retryError;
      evictPushCredentials(options.secretId, retryError);
      if (options.isTest) {
        return { outcome: 'test_refused', reason: `APNS_CREDENTIALS_REFUSED` };
      }
      throw retryError;
    }
  }
}

async function sendApnsOnce(
  message: ApnsMessage,
  options: SendApnsOptions,
  deadlineMs: number,
): Promise<PushSendResult> {
  const credentials = await loadApnsCredentials(options.secretId, options.secretsClient, {
    sandbox: options.sandboxSecret === true,
  });
  const origin =
    options.origin ??
    (credentials.environment === 'sandbox' ? APNS_SANDBOX_ORIGIN : APNS_PRODUCTION_ORIGIN);
  const jwt = apnsProviderToken(options.secretId, credentials);
  const headers: OutgoingHttpHeaders = {
    ':path': `/3/device/${encodeURIComponent(message.token)}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': credentials.bundleId,
    ...message.headers,
    'content-type': 'application/json',
  };
  const payload = JSON.stringify(message.buildPayload(credentials));
  const transport = options.transport ?? http2Transport;
  const response = await transport(
    origin,
    headers,
    payload,
    nextRequestTimeout(options.timeoutMs, deadlineMs),
  );
  if (response.status === 200) {
    const apnsId = response.headers['apns-id'];
    return {
      outcome: 'sent',
      ...(typeof apnsId === 'string' ? { providerMessageId: apnsId } : {}),
    };
  }
  const apnsError = parseApnsError(response.body);
  const reason = apnsError.reason ?? 'Unknown';
  if (response.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
    return {
      outcome: 'invalid_token',
      reason: `APNS_${reason}`,
      ...(response.status === 410 && apnsError.timestamp !== undefined
        ? { invalidSinceMs: apnsError.timestamp }
        : {}),
    };
  }
  const errorMessage = `APNs responded ${response.status} ${reason}`;
  if (APNS_AUTH_FAILURES.has(reason)) {
    throw new PushProviderAuthError(errorMessage, jwt);
  }
  // A self-test refused for configuration (DeviceTokenNotForTopic, TopicDisallowed, BadTopic…)
  // is a test failure, not a page to retry into the DLQ. Real pages keep throwing: a
  // misconfigured production stack must dead-letter and page on-call.
  if (options.isTest && isNonRetryableRefusal(response.status)) {
    return { outcome: 'test_refused', reason: `APNS_${reason}` };
  }
  throw new Error(errorMessage);
}
