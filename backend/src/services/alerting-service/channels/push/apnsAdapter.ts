import {
  sendApns,
  type Http2Transport,
  type SendApnsOptions as TransportSendApnsOptions,
} from '@boxalarm/push-transport';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  apnsCollapseId,
  apnsExpiration,
  apnsIdFor,
  buildApnsPayload,
  type PushNotification,
} from './pushPayload.js';
import type { PushSendResult } from './pushResult.js';

/**
 * The HTTP/2 session management, credential handling and response classification live in
 * @boxalarm/push-transport (extracted verbatim; see pushResult.ts for why). This adapter owns
 * what makes an alerting-plane page a page: the dispatch payload (buildApnsPayload, critical
 * or time-sensitive per the APNs secret), the exactly-once apns-id, and the per-tone
 * collapse id. Re-exports keep every alerting-plane import path unchanged.
 */
export {
  APNS_PRODUCTION_ORIGIN,
  APNS_SANDBOX_ORIGIN,
  APNS_SESSION_MAX_IDLE_MS,
  http2Transport,
  isConnectionLevelError,
  resetApnsSessions,
  type Http2Response,
  type Http2Transport,
} from '@boxalarm/push-transport';

export interface SendViaApnsOptions {
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

/**
 * Token-based (.p8) APNs send over HTTP/2. 200 → sent; 410 or BadDeviceToken → the token is
 * dead (invalid_token, not retried); anything else throws so SQS redelivers and the send
 * guard's FAILED re-claim path re-attempts. A provider-credential refusal evicts the cached
 * secret and token and is retried once in-process with freshly read credentials, so a key
 * rotation costs one extra round trip rather than a dead-lettered page.
 */
export async function sendViaApns(
  notification: PushNotification,
  options: SendViaApnsOptions,
): Promise<PushSendResult> {
  const transportOptions: TransportSendApnsOptions = {
    secretId: options.secretId,
    isTest: options.isTest,
    secretsClient: options.secretsClient,
    timeoutMs: options.timeoutMs,
    ...(options.sandboxSecret !== undefined ? { sandboxSecret: options.sandboxSecret } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  return sendApns(
    {
      token: notification.token,
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': apnsExpiration(Date.now()),
        'apns-id': apnsIdFor(notification.idempotencyKey),
        'apns-collapse-id': apnsCollapseId(notification.collapseKey),
      },
      // Per attempt, after the credential read: the interruption level (critical until #4 is
      // granted, time-sensitive meanwhile) is the APNs secret's to decide.
      buildPayload: (credentials) => buildApnsPayload(notification, credentials.interruptionLevel),
    },
    transportOptions,
  );
}
