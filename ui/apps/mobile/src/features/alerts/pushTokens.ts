import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
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

export async function registerPushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  device: DeviceToken,
): Promise<void> {
  await apiRequest(`personnel/members/${encodeURIComponent(memberId)}/push-tokens`, tokens, {
    apiBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(device),
  });
}

export async function revokePushToken(
  memberId: string,
  tokens: AuthTokenSource,
  apiBaseUrl: string,
): Promise<void> {
  await apiRequest(`personnel/members/${encodeURIComponent(memberId)}/push-tokens`, tokens, {
    apiBaseUrl,
    method: 'DELETE',
  });
}
