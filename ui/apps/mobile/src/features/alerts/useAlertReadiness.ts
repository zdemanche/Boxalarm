import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import Config from 'react-native-config';
import {
  guideToDndAccess,
  guideToFullScreenIntent,
  readAndroidDeviceReadiness,
} from './alertReadiness';
import { currentCriticalChannelId } from './pushChannel';

export type ReadinessStatus = 'ok' | 'fail' | 'warn' | 'unknown';

export interface ReadinessItem {
  id: 'notifications' | 'dnd' | 'fullScreen' | 'battery' | 'criticalAlerts';
  label: string;
  status: ReadinessStatus;
  /** What it means for a page at 03:00, in words. */
  detail: string;
  fixLabel?: string;
  fix?: () => void;
  /** A failure here means the phone may not wake the member: it raises the red banner. */
  wakes: boolean;
}

function openAppNotificationSettings(): void {
  if (Platform.OS === 'android') {
    notifee.openNotificationSettings().catch(() => void Linking.openSettings());
    return;
  }
  void Linking.openSettings();
}

/**
 * Evaluates, on the device and without the network, whether a page can wake this phone. Each
 * check fails closed: a state that cannot be read is "unknown", never "ok".
 */
export async function evaluateAlertReadiness(): Promise<ReadinessItem[]> {
  const items: ReadinessItem[] = [];

  let authorization: number | null = null;
  let iosCriticalAlert: number | undefined;
  try {
    const settings = await notifee.getNotificationSettings();
    authorization = settings.authorizationStatus;
    iosCriticalAlert = settings.ios?.criticalAlert;
  } catch (error) {
    console.warn('[readiness] reading notification settings failed', error);
  }
  let channelBlocked = false;
  if (Platform.OS === 'android' && authorization === AuthorizationStatus.AUTHORIZED) {
    channelBlocked = await notifee
      .isChannelBlocked(await currentCriticalChannelId())
      .catch(() => false);
  }

  if (authorization === AuthorizationStatus.PROVISIONAL) {
    items.push({
      id: 'notifications',
      label: 'Notifications',
      status: 'fail',
      detail:
        'Delivered quietly: pages go straight to Notification Center with no sound or banner.',
      fixLabel: 'Turn on alerts',
      fix: openAppNotificationSettings,
      wakes: true,
    });
  } else if (authorization === AuthorizationStatus.AUTHORIZED && !channelBlocked) {
    items.push({
      id: 'notifications',
      label: 'Notifications',
      status: 'ok',
      detail: 'Allowed.',
      wakes: true,
    });
  } else {
    items.push({
      id: 'notifications',
      label: 'Notifications',
      status: authorization === null ? 'unknown' : 'fail',
      detail: channelBlocked
        ? 'Dispatch pages are turned off for Boxalarm in Settings.'
        : authorization === null
          ? "Couldn't check notification permission."
          : 'Off: this phone will not show or sound pages.',
      fixLabel: 'Turn on notifications',
      fix: openAppNotificationSettings,
      wakes: true,
    });
  }

  if (Platform.OS === 'android') {
    const device = await readAndroidDeviceReadiness();
    items.push({
      id: 'dnd',
      label: 'Ring through Do Not Disturb',
      status: device === null ? 'unknown' : device.dndAccessGranted ? 'ok' : 'fail',
      detail:
        device?.dndAccessGranted === true
          ? 'Allowed.'
          : 'Not allowed: with Do Not Disturb or Bedtime on, a page is silent.',
      fixLabel: 'Allow',
      fix: guideToDndAccess,
      wakes: true,
    });
    if (device === null || device.sdkInt >= 34) {
      items.push({
        id: 'fullScreen',
        label: 'Full-screen page on the lock screen',
        status: device === null ? 'unknown' : device.fullScreenIntentAllowed ? 'ok' : 'fail',
        detail:
          device?.fullScreenIntentAllowed === true
            ? 'Allowed.'
            : 'Not allowed: a page shows as a small banner that disappears.',
        fixLabel: 'Allow',
        fix: guideToFullScreenIntent,
        wakes: true,
      });
    }
    const optimized = await notifee.isBatteryOptimizationEnabled().catch(() => null);
    items.push({
      id: 'battery',
      label: 'Battery optimization',
      status: optimized === null ? 'unknown' : optimized ? 'warn' : 'ok',
      detail: optimized
        ? 'On: some phones delay pages to save battery. Turning it off for Boxalarm is safer.'
        : 'Off for Boxalarm.',
      fixLabel: 'Turn off',
      fix: () => void notifee.openBatteryOptimizationSettings(),
      wakes: false,
    });
  } else {
    const entitled = Config.CRITICAL_ALERTS_ENTITLEMENT_GRANTED === 'true';
    items.push({
      id: 'criticalAlerts',
      label: 'Critical Alerts (sound on silent)',
      status: !entitled ? 'warn' : iosCriticalAlert === 1 ? 'ok' : 'fail',
      detail: !entitled
        ? 'Waiting on Apple approval. Until then, keep the ring/silent switch on ring and allow Boxalarm in your Sleep Focus.'
        : iosCriticalAlert === 1
          ? 'Allowed: pages sound even on silent.'
          : 'Off: with the ring switch on silent, a page makes no sound.',
      ...(entitled ? { fixLabel: 'Turn on', fix: openAppNotificationSettings } : {}),
      wakes: entitled,
    });
  }

  return items;
}

/** The checks that fail and would stop a page waking the member - what the red banner names. */
export function blockingReadinessItems(items: readonly ReadinessItem[]): ReadinessItem[] {
  return items.filter((item) => item.wakes && item.status === 'fail');
}

export interface AlertReadinessState {
  items: ReadinessItem[] | null;
  blocking: ReadinessItem[];
  refresh: () => Promise<void>;
}

/** Re-evaluated on mount and every return to the foreground (the member comes back from Settings). */
export function useAlertReadiness(): AlertReadinessState {
  const [items, setItems] = useState<ReadinessItem[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await evaluateAlertReadiness());
    } catch (error) {
      console.warn('[readiness] evaluating alert readiness failed', error);
    }
  }, []);

  useEffect(() => {
    let active = true;
    evaluateAlertReadiness()
      .then((result) => {
        if (active) setItems(result);
      })
      .catch((error: unknown) => console.warn('[readiness] evaluation failed', error));
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void refresh();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [refresh]);

  return { items, blocking: items ? blockingReadinessItems(items) : [], refresh };
}
