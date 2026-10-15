import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { version as appVersion } from '../../../package.json';
import { evaluateAlertReadiness, type ReadinessItem } from './useAlertReadiness';

export function deviceStatePayload(items: readonly ReadinessItem[]) {
  const ok = (...ids: ReadinessItem['id'][]) =>
    items.some((item) => ids.includes(item.id) && item.status === 'ok');
  return {
    notificationPermission: ok('notifications'),
    criticalAlertPermission: ok('criticalAlerts', 'dnd'),
    batteryOptimizationExempt: Platform.OS === 'android' ? ok('battery') : true,
    appVersion,
    osVersion: `${Platform.OS} ${String(Platform.Version)}`,
  };
}

/** Self-reports permission state for the "why didn't I get the page" diagnostics; never blocks paging. */
export function useDeviceStateReport(): void {
  const auth = useOptionalAuth();
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const memberId = auth?.memberId ?? null;
  const apiBaseUrl = Config.API_BASE_URL;
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    if (!isAuthenticated || !memberId || !apiBaseUrl) return;
    let cancelled = false;

    const report = async () => {
      const tokens = authRef.current;
      if (!tokens) return;
      try {
        const body = JSON.stringify(deviceStatePayload(await evaluateAlertReadiness()));
        if (cancelled) return;
        await apiRequest('alerting/devices/state', tokens, {
          apiBaseUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        console.warn('[push] device state report failed', error);
      }
    };

    void report();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void report();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isAuthenticated, memberId, apiBaseUrl]);
}
