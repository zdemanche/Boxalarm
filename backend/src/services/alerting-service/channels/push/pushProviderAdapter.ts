import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createChannelSecretsClient } from '../httpProviderAdapter.js';
import { sendViaApns, type Http2Transport } from './apnsAdapter.js';
import { sendViaFcm } from './fcmAdapter.js';
import {
  loadApnsCredentials,
  readPushSecretId,
  type ApnsEnvironment,
  type ApnsInterruptionLevel,
  type PushPlatform,
} from './pushCredentials.js';
import type { PushNotification } from './pushPayload.js';
import type { PushSendResult } from './pushResult.js';

export type { PushNotification } from './pushPayload.js';
export type { PushSendResult } from './pushResult.js';

/** Same per-request budget as the SMS/voice adapter — the worker's Lambda timeout is 15s. */
export const PUSH_PROVIDER_REQUEST_TIMEOUT_MS = 4_000;

const APNS_DEVICE_TOKEN = /^[0-9a-f]{64}$/i;

/**
 * Which gateway a registered token belongs to. The app registers `{ platform: 'APNS' }` with
 * the raw APNs device token on iOS and `{ platform: 'FCM' }` on Android (the personnel plane's
 * registerToken.ts). An entry with no platform falls back on the token's shape: a raw APNs
 * token is 64 hex characters, an FCM registration token never is.
 */
export function resolvePushPlatform(platform: string | undefined, token: string): PushPlatform {
  const normalized = platform?.toUpperCase();
  if (normalized === 'APNS' || normalized === 'IOS') return 'APNS';
  if (normalized === 'FCM' || normalized === 'ANDROID') return 'FCM';
  return APNS_DEVICE_TOKEN.test(token) ? 'APNS' : 'FCM';
}

export interface SendPushOptions {
  /**
   * Self-test/canary: a labelled test payload. APNs goes to the device's own environment
   * (apnsEnvironment) so it rings the real device; FCM uses its sandbox secret, validate_only.
   */
  readonly isTest?: boolean;
  /** The iOS device token's APNs environment; unset is production. */
  readonly apnsEnvironment?: ApnsEnvironment;
  readonly secretsClient?: SecretsManagerClient;
  /** Test seams. */
  readonly apnsTransport?: Http2Transport;
  readonly apnsOrigin?: string;
  readonly fcmOrigin?: string;
  readonly oauthTokenUrl?: string;
}

/**
 * Direct APNs / FCM push (architecture §Alerting: no third-party push vendor). Resolves the
 * credentials for exactly the platform being sent to, so a missing FCM secret never blocks
 * an iOS page and vice versa.
 */
export async function sendPush(
  notification: PushNotification,
  platform: PushPlatform,
  env: NodeJS.ProcessEnv,
  options: SendPushOptions = {},
): Promise<PushSendResult> {
  const isTest = options.isTest === true;
  const apnsEnvironment = options.apnsEnvironment ?? 'production';
  const secretId = readPushSecretId(platform, env, { isTest, apnsEnvironment });
  const secretsClient = createChannelSecretsClient(options.secretsClient);
  const common = { secretId, isTest, secretsClient, timeoutMs: PUSH_PROVIDER_REQUEST_TIMEOUT_MS };
  if (platform === 'APNS') {
    return sendViaApns(notification, {
      ...common,
      sandboxSecret: apnsEnvironment === 'development',
      ...(options.apnsTransport ? { transport: options.apnsTransport } : {}),
      ...(options.apnsOrigin ? { origin: options.apnsOrigin } : {}),
    });
  }
  const apnsInterruptionLevel = await apnsInterruptionLevelFor(env, secretsClient);
  return sendViaFcm(notification, {
    ...common,
    ...(apnsInterruptionLevel ? { apnsInterruptionLevel } : {}),
    ...(options.fcmOrigin ? { fcmOrigin: options.fcmOrigin } : {}),
    ...(options.oauthTokenUrl ? { oauthTokenUrl: options.oauthTokenUrl } : {}),
  });
}

/**
 * The interruption level lives in one place: the APNs secret's `interruptionLevel`. FCM's apns
 * block (for iOS devices still on a legacy FCM token) takes it from there too. An operator who
 * switches the APNs secret to `time-sensitive` until #4 is granted therefore switches both
 * paths. Best effort: an Android page must never fail because the APNs secret is unset or
 * unreadable, so FCM then falls back to its own secret's `apnsInterruptionLevel`, then
 * `critical`. The read is cached and coalesced like every other credential read.
 */
/**
 * How long the Android path trusts the APNs-level lookup, success or failure. On an
 * Android-only stack, or while the APNs secret is unreadable or throttled, every Android page
 * would otherwise make one more failing Secrets Manager call. That time falls outside the 8s
 * send budget, and SDK retry backoff adds to it during throttling.
 */
export const APNS_LEVEL_LOOKUP_TTL_MS = 60_000;

const apnsLevelLookups = new Map<
  string,
  { readonly level: Promise<ApnsInterruptionLevel | undefined>; readonly expiresAt: number }
>();

async function apnsInterruptionLevelFor(
  env: NodeJS.ProcessEnv,
  secretsClient: SecretsManagerClient,
): Promise<ApnsInterruptionLevel | undefined> {
  const key = `prod#${env.APNS_SECRET_ID ?? ''}`;
  const cached = apnsLevelLookups.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.level;
  }
  const level = lookUpApnsInterruptionLevel(env, secretsClient);
  apnsLevelLookups.set(key, { level, expiresAt: Date.now() + APNS_LEVEL_LOOKUP_TTL_MS });
  return level;
}

async function lookUpApnsInterruptionLevel(
  env: NodeJS.ProcessEnv,
  secretsClient: SecretsManagerClient,
): Promise<ApnsInterruptionLevel | undefined> {
  try {
    const apnsSecretId = readPushSecretId('APNS', env);
    return (await loadApnsCredentials(apnsSecretId, secretsClient)).interruptionLevel;
  } catch {
    return undefined;
  }
}
