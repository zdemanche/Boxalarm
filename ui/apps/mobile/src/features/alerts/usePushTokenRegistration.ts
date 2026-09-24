import { useEffect, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getNativePushBridge, registerPushToken, type DeviceToken } from './pushTokens';

/**
 * Requests notification permission and registers/rotates the device push token once signed in
 * (F1.-adjacent, E1-S14-UI). Retries silently on the next mount (e.g. after reconnect) if the
 * native bridge or the register call fails - there is no user-facing action to retry manually.
 */
export function usePushTokenRegistration(): void {
  const auth = useOptionalAuth();
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const memberId = auth?.memberId ?? null;
  const apiBaseUrl = Config.API_BASE_URL;
  const authRef = useRef(auth);
  authRef.current = auth;
  const lastRegisteredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !memberId || !apiBaseUrl) return;

    const bridge = getNativePushBridge();
    let cancelled = false;

    const register = async (device: DeviceToken) => {
      const key = `${device.platform}:${device.token}`;
      if (lastRegisteredRef.current === key) return;
      const tokens = authRef.current;
      if (!tokens) return;
      await registerPushToken(memberId, tokens, apiBaseUrl, device);
      if (!cancelled) lastRegisteredRef.current = key;
    };

    void (async () => {
      const granted = await bridge.requestPermission();
      if (!granted || cancelled) return;
      const device = await bridge.getToken();
      if (device) await register(device);
    })();

    const unsubscribe = bridge.onTokenRefresh((device) => {
      void register(device);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isAuthenticated, memberId, apiBaseUrl]);
}
