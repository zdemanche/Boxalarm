import Config from 'react-native-config';
import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import { getDeviceInstallationId } from './deviceInstallationId';
import { firebaseNativePushBridge } from './nativePushBridge';

export type PushPlatform = 'APNS' | 'FCM';

export interface DeviceToken {
  platform: PushPlatform;
  token: string;
}

export interface NativePushBridge {
  requestPermission(): Promise<boolean>;
  getToken(): Promise<DeviceToken | null>;
  onTokenRefresh(listener: (token: DeviceToken) => void): () => void;
}

export function getNativePushBridge(): NativePushBridge {
  return firebaseNativePushBridge;
}

/**
 * The APNs environment this build's `aps-environment` entitlement is signed for: `development`
 * for a debug build installed from Xcode, `production` for TestFlight and App Store builds. The
 * backend sends every push - self-test included - on this environment's host, because a token
 * only works on its own.
 *
 * The signed entitlement itself is not readable from JavaScript (it lives in the provisioning
 * profile; App Store and TestFlight builds carry none), and the app has no native module, so the
 * build configuration stands in for it: `__DEV__` (Debug -> development, Release -> production).
 * The one case that gets wrong - a Release build installed from Xcode with development signing -
 * must set `APNS_ENVIRONMENT=development` in its .env (see .env.example); otherwise its real
 * pages get BadDeviceToken and the token is disabled until it re-registers.
 */
export function apnsEnvironment(): 'development' | 'production' {
  const configured = (Config as Record<string, string | undefined>).APNS_ENVIRONMENT;
  if (configured === 'development' || configured === 'production') return configured;
  return __DEV__ ? 'development' : 'production';
}

/**
 * Which sign-in registrations belong to (m3). Sign-out moves it on before its revoke, so a
 * registration started for the session being signed out - a backoff retry, a token rotation -
 * is refused instead of re-creating the entry the revoke is about to delete.
 */
let registrationEpoch = 0;
const inFlightRegistrations = new Set<Promise<unknown>>();

export function currentRegistrationEpoch(): number {
  return registrationEpoch;
}

/** A registration refused because its sign-in is being (or has been) signed out. */
export class RegistrationCancelledError extends Error {
  constructor() {
    super('push registration cancelled: signing out');
    this.name = 'RegistrationCancelledError';
  }
}

/**
 * Sign-out, before the revoke: refuses every registration of the ending session from now on and
 * waits (bounded) for one already sent, so it cannot land after the DELETE.
 */
export async function stopRegistrations(timeoutMs: number): Promise<void> {
  registrationEpoch += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...inFlightRegistrations].map((sent) => sent.catch(() => undefined))),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Registers this installation's token. `deviceId` makes it one of the member's devices rather
 * than a replacement for their only one: signing in here never stops another device's pages.
 * `epoch` (currentRegistrationEpoch when the sign-in's registration started) refuses it once that
 * sign-in is being signed out.
 */
export async function registerPushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  device: DeviceToken,
  epoch?: number,
): Promise<void> {
  const deviceId = await getDeviceInstallationId();
  if (epoch !== undefined && epoch !== registrationEpoch) throw new RegistrationCancelledError();
  const sent = apiRequest(`personnel/members/${encodeURIComponent(memberId)}/push-tokens`, tokens, {
    apiBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...device,
      deviceId,
      ...(device.platform === 'APNS' ? { apnsEnvironment: apnsEnvironment() } : {}),
    }),
  });
  inFlightRegistrations.add(sent);
  try {
    await sent;
  } finally {
    inFlightRegistrations.delete(sent);
  }
}

/**
 * Sign-out: removes only this installation's entry; the member's other devices keep paging.
 * `deviceId` defaults to this installation's (a pending revoke retried later names it).
 */
export async function revokePushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  deviceId?: string,
): Promise<void> {
  deviceId ??= await getDeviceInstallationId();
  await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/push-tokens?deviceId=${encodeURIComponent(deviceId)}`,
    tokens,
    { apiBaseUrl, method: 'DELETE' },
  );
}
