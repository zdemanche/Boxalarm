import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  evictPushCredentials,
  fcmAccessToken,
  loadFcmCredentials,
  PushProviderAuthError,
  type FcmCredentials,
} from './pushCredentials.js';
import {
  fetchRetryingConnectionLoss,
  isNonRetryableRefusal,
  nextRequestTimeout,
  PUSH_SEND_BUDGET_REQUESTS,
  type PushSendResult,
} from './pushResult.js';

export const FCM_ORIGIN = 'https://fcm.googleapis.com';

/**
 * One FCM HTTP v1 send, payload-agnostic. The caller owns the whole request body
 * (`validate_only` and `message`, token included). `buildRequest` runs per attempt, after the
 * credentials are read, because the body may depend on them (the alerting plane's apns block
 * falls back to the FCM secret's own `apnsInterruptionLevel`).
 */
export interface FcmMessage {
  readonly buildRequest: (credentials: FcmCredentials) => Record<string, unknown>;
}

export interface SendFcmOptions {
  readonly secretId: string;
  /** A self-test/canary push: configuration refusals are a failed test, not a retried page. */
  readonly isTest: boolean;
  readonly secretsClient: SecretsManagerClient;
  readonly timeoutMs: number;
  /** Test seams: a local HTTP server in place of Google. */
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

interface FcmErrorBody {
  readonly error?: {
    readonly status?: string;
    readonly message?: string;
    readonly details?: readonly {
      readonly errorCode?: string;
      readonly fieldViolations?: readonly { readonly field?: string }[];
    }[];
  };
}

function parseError(text: string): FcmErrorBody['error'] {
  try {
    return (JSON.parse(text) as FcmErrorBody).error;
  } catch {
    return undefined;
  }
}

/**
 * INVALID_ARGUMENT is a dead token only when it names the token; any other invalid argument
 * is a payload bug and must stay loud (throw → DLQ → alarm), never silently disable a
 * member's device.
 */
function isTokenArgumentError(error: FcmErrorBody['error']): boolean {
  const namesTokenField = (error?.details ?? []).some((detail) =>
    (detail.fieldViolations ?? []).some((violation) => violation.field === 'message.token'),
  );
  return namesTokenField || /registration token/i.test(error?.message ?? '');
}

/**
 * A credential refusal (FCM 401, a 403 that is not a sender mismatch, or the token endpoint
 * refusing the service account) evicts the cached secret and access token and is retried once
 * in-process with freshly read credentials; see sendApns.
 */
export async function sendFcm(
  message: FcmMessage,
  options: SendFcmOptions,
): Promise<PushSendResult> {
  const deadlineMs = Date.now() + PUSH_SEND_BUDGET_REQUESTS * options.timeoutMs;
  try {
    return await sendFcmOnce(message, options, deadlineMs);
  } catch (error) {
    if (!(error instanceof PushProviderAuthError)) throw error;
    evictPushCredentials(options.secretId, error);
    try {
      return await sendFcmOnce(message, options, deadlineMs);
    } catch (retryError) {
      if (!(retryError instanceof PushProviderAuthError)) throw retryError;
      evictPushCredentials(options.secretId, retryError);
      if (options.isTest) {
        return { outcome: 'test_refused', reason: `FCM_CREDENTIALS_REFUSED` };
      }
      throw retryError;
    }
  }
}

async function sendFcmOnce(
  message: FcmMessage,
  options: SendFcmOptions,
  deadlineMs: number,
): Promise<PushSendResult> {
  const credentials = await loadFcmCredentials(options.secretId, options.secretsClient);
  const nextTimeoutMs = () => nextRequestTimeout(options.timeoutMs, deadlineMs);
  const accessToken = await fcmAccessToken(options.secretId, credentials, {
    timeoutMs: nextTimeoutMs(),
    nextTimeoutMs,
    ...(options.oauthTokenUrl ? { tokenUrl: options.oauthTokenUrl } : {}),
  });
  const origin = options.fcmOrigin ?? FCM_ORIGIN;
  const response = await fetchRetryingConnectionLoss(
    `${origin}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(message.buildRequest(credentials)),
    },
    nextTimeoutMs,
  );
  const text = await response.text();
  if (response.ok) {
    let name: unknown;
    try {
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    return { outcome: 'sent', ...(typeof name === 'string' ? { providerMessageId: name } : {}) };
  }
  const error = parseError(text);
  const errorCode =
    error?.details?.find((detail) => typeof detail.errorCode === 'string')?.errorCode ??
    error?.status ??
    'UNKNOWN';
  // Only the explicit code: a bare 404 can also mean a wrong project_id, and treating that as
  // a dead token would disable every member's device on a misconfiguration.
  if (errorCode === 'UNREGISTERED') {
    return { outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' };
  }
  if (errorCode === 'INVALID_ARGUMENT' && isTokenArgumentError(error)) {
    return { outcome: 'invalid_token', reason: 'FCM_INVALID_ARGUMENT' };
  }
  const errorMessage = `FCM responded ${response.status} ${errorCode}`;
  if (response.status === 401 || (response.status === 403 && errorCode !== 'SENDER_ID_MISMATCH')) {
    throw new PushProviderAuthError(errorMessage, accessToken);
  }
  // A self-test refused for configuration (SENDER_ID_MISMATCH when the sandbox service account
  // is in another Firebase project, a payload INVALID_ARGUMENT…) is a test failure, not a page
  // to retry into the DLQ. Real pages keep throwing so a misconfigured stack pages on-call.
  if (options.isTest && isNonRetryableRefusal(response.status)) {
    return { outcome: 'test_refused', reason: `FCM_${errorCode}` };
  }
  throw new Error(errorMessage);
}
