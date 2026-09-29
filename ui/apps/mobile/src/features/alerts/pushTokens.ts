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
 * Registers this installation's token. `deviceId` makes it one of the member's devices rather
 * than a replacement for their only one: signing in here never stops another device's pages.
 */
export async function registerPushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  device: DeviceToken,
): Promise<void> {
  const deviceId = await getDeviceInstallationId();
  await apiRequest(`personnel/members/${encodeURIComponent(memberId)}/push-tokens`, tokens, {
    apiBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...device, deviceId }),
  });
}

/** Sign-out: removes only this installation's entry; the member's other devices keep paging. */
export async function revokePushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
): Promise<void> {
  const deviceId = await getDeviceInstallationId();
  await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/push-tokens?deviceId=${encodeURIComponent(deviceId)}`,
    tokens,
    { apiBaseUrl, method: 'DELETE' },
  );
}
