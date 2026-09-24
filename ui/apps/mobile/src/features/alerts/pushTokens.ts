import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';

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

// TODO: E1-S14-UI - no native push SDK is linked in this repo yet (no APNs/Firebase bridge
// module, no google-services.json per environment). This stands in until a native-focused pass
// adds the real iOS/Android bridge; the HTTP registration/rotation/revocation lifecycle below is
// real today and drives itself off whatever this returns.
const unavailableBridge: NativePushBridge = {
  async requestPermission() {
    return false;
  },
  async getToken() {
    return null;
  },
  onTokenRefresh() {
    return () => {};
  },
};

export function getNativePushBridge(): NativePushBridge {
  return unavailableBridge;
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
