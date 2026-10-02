/**
 * APNs/FCM credential loading, JWT/OAuth minting and eviction, extracted verbatim to
 * @boxalarm/push-transport (see pushResult.ts for why). Re-exported here so every
 * alerting-plane import path is unchanged. Secret JSON shapes stay documented in
 * infrastructure/components/alerting/channel-workers.ts.
 */
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
} from '@boxalarm/push-transport';
