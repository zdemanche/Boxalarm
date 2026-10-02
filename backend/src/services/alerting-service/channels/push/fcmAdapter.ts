import { sendFcm } from '@boxalarm/push-transport';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ApnsInterruptionLevel } from './pushCredentials.js';
import {
  apnsCollapseId,
  apnsExpiration,
  buildApnsPayload,
  PUSH_TTL_SECONDS,
  pushDataFields,
  type PushNotification,
} from './pushPayload.js';
import type { PushSendResult } from './pushResult.js';

/**
 * The HTTP mechanics, credential handling and response classification live in
 * @boxalarm/push-transport (extracted verbatim; see pushResult.ts for why). This adapter owns
 * the alerting-plane message shape: the HIGH-priority data-only Android page and the critical
 * apns block for legacy-token iOS devices.
 */
export { FCM_ORIGIN } from '@boxalarm/push-transport';

export interface SendViaFcmOptions {
  readonly secretId: string;
  /**
   * Interruption level for the apns block, taken from the APNs secret (the single source of
   * truth, see pushProviderAdapter.sendPush). Falls back to the FCM secret's own
   * `apnsInterruptionLevel`, then `critical`, only when the APNs secret cannot be read.
   */
  readonly apnsInterruptionLevel?: ApnsInterruptionLevel;
  readonly isTest: boolean;
  /**
   * FCM validates the whole message (token included) but delivers nothing. The scheduled
   * canary without a dedicated device; a member's self-test really delivers (labelled TEST).
   */
  readonly validateOnly?: boolean;
  readonly secretsClient: SecretsManagerClient;
  readonly timeoutMs: number;
  /** Test seams: a local HTTP server in place of Google. */
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

/**
 * FCM HTTP v1 message. Android gets a HIGH-priority **data-only** message (architecture
 * §5.2): the app's background handler posts it on the `dispatch-critical` notifee channel
 * itself, so it is displayed even when the app is killed. The `apns` block only applies to an
 * iOS device that registered an FCM token before the app switched to raw APNs tokens — it
 * keeps those devices paged, critically, until they re-register.
 */
export function buildFcmRequest(
  notification: PushNotification,
  validateOnly: boolean,
  nowMs: number = Date.now(),
  apnsInterruptionLevel: ApnsInterruptionLevel = 'critical',
): Record<string, unknown> {
  return {
    // FCM validates the whole message (token included) but delivers nothing.
    ...(validateOnly ? { validate_only: true } : {}),
    message: {
      token: notification.token,
      data: pushDataFields(notification),
      android: { priority: 'HIGH', ttl: `${PUSH_TTL_SECONDS}s` },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-expiration': apnsExpiration(nowMs),
          'apns-push-type': 'alert',
          'apns-collapse-id': apnsCollapseId(notification.collapseKey),
        },
        payload: buildApnsPayload(notification, apnsInterruptionLevel),
      },
    },
  };
}

/**
 * A credential refusal (FCM 401, a 403 that is not a sender mismatch, or the token endpoint
 * refusing the service account) evicts the cached secret and access token and is retried once
 * in-process with freshly read credentials; see sendViaApns.
 */
export async function sendViaFcm(
  notification: PushNotification,
  options: SendViaFcmOptions,
): Promise<PushSendResult> {
  return sendFcm(
    {
      buildRequest: (credentials) =>
        buildFcmRequest(
          notification,
          options.validateOnly ?? options.isTest,
          Date.now(),
          options.apnsInterruptionLevel ?? credentials.apnsInterruptionLevel,
        ),
    },
    {
      secretId: options.secretId,
      isTest: options.isTest,
      secretsClient: options.secretsClient,
      timeoutMs: options.timeoutMs,
      ...(options.fcmOrigin ? { fcmOrigin: options.fcmOrigin } : {}),
      ...(options.oauthTokenUrl ? { oauthTokenUrl: options.oauthTokenUrl } : {}),
    },
  );
}
