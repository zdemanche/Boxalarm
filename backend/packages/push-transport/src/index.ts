/**
 * The provider-facing core of a direct APNs / FCM push: HTTP/2 session management, credential
 * loading and JWT/OAuth minting from Secrets Manager, send-budget bookkeeping, and response
 * classification (sent / invalid_token / test_refused / throw-to-redeliver).
 *
 * Deliberately payload-agnostic. The alerting plane's critical dispatch shape and the
 * notification plane's non-critical shape each live with their own worker; this package knows
 * nothing about either, so sharing it cannot let a LOB notification borrow the alerting
 * plane's presentation. It also touches no DynamoDB table — the IAM boundary between the
 * planes is unaffected by both importing it.
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
} from './http2.js';
export {
  APNS_JWT_MAX_AGE_MS,
  apnsProviderToken,
  evictPushCredentials,
  FCM_ACCESS_TOKEN_MAX_AGE_MS,
  FCM_OAUTH_SCOPE,
  fcmAccessToken,
  GOOGLE_OAUTH_TOKEN_URL,
  loadApnsCredentials,
  loadFcmCredentials,
  PushCredentialsUnavailableError,
  PushProviderAuthError,
  readPushSecretId,
  resetPushCredentialCaches,
  type ApnsCredentials,
  type ApnsEnvironment,
  type ApnsInterruptionLevel,
  type FcmAccessTokenOptions,
  type FcmCredentials,
  type PushPlatform,
} from './pushCredentials.js';
export {
  fetchRetryingConnectionLoss,
  isFetchConnectionLoss,
  isNonRetryableRefusal,
  nextRequestTimeout,
  PUSH_SEND_BUDGET_REQUESTS,
  type PushSendResult,
} from './pushResult.js';
export { sendApns, type ApnsMessage, type SendApnsOptions } from './apnsSend.js';
export { FCM_ORIGIN, sendFcm, type FcmMessage, type SendFcmOptions } from './fcmSend.js';
