import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import {
  alertReadinessNative,
  guideToDndAccess,
  guideToFullScreenIntent,
  readAndroidDeviceReadiness,
} from './alertReadiness';
import { currentCriticalChannelId } from './pushChannel';
import {
  getPushRegistration,
  retryPushRegistration,
  subscribePushRegistration,
  type PushRegistrationState,
} from './pushRegistrationState';

export type ReadinessStatus = 'ok' | 'fail' | 'warn' | 'unknown';

export interface ReadinessItem {
  id:
    | 'registration'
    | 'notifications'
    | 'channel'
    | 'dnd'
    | 'fullScreen'
    | 'battery'
    | 'criticalAlerts';
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
  let iosSound: number | undefined;
  let iosAlert: number | undefined;
  try {
    const settings = await notifee.getNotificationSettings();
    authorization = settings.authorizationStatus;
    iosCriticalAlert = settings.ios?.criticalAlert;
    iosSound = settings.ios?.sound;
    iosAlert = settings.ios?.alert;
  } catch (error) {
    console.warn('[readiness] reading notification settings failed', error);
  }
  const criticalId = Platform.OS === 'android' ? await currentCriticalChannelId() : null;
  // null = could not read (unknown), never assumed unblocked (review MJ-3).
  let channelBlocked: boolean | null = false;
  if (criticalId && authorization === AuthorizationStatus.AUTHORIZED) {
    channelBlocked = await notifee.isChannelBlocked(criticalId).catch(() => null);
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
  } else if (authorization === AuthorizationStatus.AUTHORIZED && channelBlocked === false) {
    // iOS: allowed, but Sounds or Alerts can still be switched off per app. 0 = disabled.
    const silentIos = iosSound === 0;
    const hiddenIos = iosAlert === 0;
    items.push({
      id: 'notifications',
      label: 'Notifications',
      status: silentIos || hiddenIos ? 'fail' : 'ok',
      detail: silentIos
        ? 'Sounds are off for Boxalarm: a page arrives silently.'
        : hiddenIos
          ? 'Alerts are off for Boxalarm: a page shows no banner or lock-screen alert.'
          : 'Allowed.',
      ...(silentIos || hiddenIos
        ? { fixLabel: 'Turn on sounds and alerts', fix: openAppNotificationSettings }
        : {}),
      wakes: true,
    });
  } else {
    items.push({
      id: 'notifications',
      label: 'Notifications',
      status: authorization === null || channelBlocked === null ? 'unknown' : 'fail',
      detail: channelBlocked
        ? 'Dispatch pages are turned off for Boxalarm in Settings.'
        : authorization === null || channelBlocked === null
          ? "Couldn't confirm notifications are allowed."
          : 'Off: this phone will not show or sound pages.',
      fixLabel: 'Turn on notifications',
      fix: openAppNotificationSettings,
      wakes: true,
    });
  }

  if (Platform.OS === 'android' && criticalId) {
    const device = await readAndroidDeviceReadiness();
    const openChannel = () =>
      void notifee.openNotificationSettings(criticalId).catch(() => Linking.openSettings());

    // The channel pages actually post on: a member can lower it or make it silent in Settings.
    let channel: { importance?: number; sound?: string; soundURI?: string } | null | undefined;
    try {
      channel = await notifee.getChannel(criticalId);
    } catch {
      channel = undefined;
    }
    const channelSilent = channel ? !channel.sound && !channel.soundURI : false;
    const channelLowered =
      channel?.importance !== undefined && channel.importance < AndroidImportance.HIGH;
    items.push({
      id: 'channel',
      label: 'Dispatch page sound',
      status:
        channel === undefined
          ? 'unknown'
          : channel === null || channelSilent || channelLowered
            ? 'fail'
            : 'ok',
      detail:
        channel === undefined
          ? "Couldn't confirm the dispatch channel will ring."
          : channel === null
            ? 'The dispatch channel is not set up yet. Open Boxalarm once, then check again.'
            : channelSilent
              ? '"Dispatch pages" is set to silent in Settings: a page makes no sound.'
              : channelLowered
                ? '"Dispatch pages" was lowered in Settings: a page will not pop up or ring.'
                : 'Rings with the alarm sound.',
      fixLabel: 'Open channel settings',
      fix: openChannel,
      wakes: true,
    });

    // Access alone is not enough: the channel must actually have been created with it.
    let bypass: boolean | null = null;
    if (device?.dndAccessGranted) {
      const native = alertReadinessNative();
      try {
        bypass = native ? await native.getChannelBypassDnd(criticalId) : null;
      } catch {
        bypass = null;
      }
    }
    const dndStatus: ReadinessStatus =
      device === null
        ? 'unknown'
        : !device.dndAccessGranted
          ? 'fail'
          : bypass === null
            ? 'unknown'
            : bypass
              ? 'ok'
              : 'fail';
    items.push({
      id: 'dnd',
      label: 'Ring through Do Not Disturb',
      status: dndStatus,
      detail:
        dndStatus === 'ok'
          ? 'Allowed.'
          : dndStatus === 'unknown'
            ? "Couldn't confirm pages ring through Do Not Disturb."
            : device?.dndAccessGranted
              ? 'Allowed for Boxalarm, but "Override Do Not Disturb" is off on the Dispatch pages channel.'
              : 'Not allowed: with Do Not Disturb or Bedtime on, a page is silent.',
      fixLabel: device?.dndAccessGranted ? 'Open channel settings' : 'Allow',
      fix: device?.dndAccessGranted ? openChannel : guideToDndAccess,
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
        ? 'Waiting on Apple approval. Until then, keep the ring/silent switch on ring, allow Boxalarm in your Sleep Focus, and keep Time Sensitive Notifications on for Boxalarm (this app cannot read that setting).'
        : iosCriticalAlert === 1
          ? 'Allowed: pages sound even on silent.'
          : 'Off: with the ring switch on silent, a page makes no sound.',
      ...(entitled ? { fixLabel: 'Turn on', fix: openAppNotificationSettings } : {}),
      wakes: entitled,
    });
  }

  return items;
}

/**
 * Whether the server will send this member's pages to this phone at all (C1). Every device check
 * can pass while the server has no entry for this phone - after a sign-out deleted it, say - so
 * anything short of a confirmed registration for the member signed in now is not "ready". While
 * the first attempt is still running it is a warning, not the red banner, so signing in does not
 * flash red.
 */
export function registrationReadinessItem(
  memberId: string,
  state: PushRegistrationState | null,
): ReadinessItem {
  const status = state?.memberId === memberId ? state.status : 'registering';
  const base = { id: 'registration', label: 'Pages on this phone', wakes: true } as const;
  if (status === 'registered')
    return { ...base, status: 'ok', detail: 'Registered for your pages.' };
  if (status === 'registering') {
    return {
      ...base,
      status: 'warn',
      detail: 'Registering this phone for your pages. Until it finishes, use the radio.',
    };
  }
  return {
    ...base,
    status: 'fail',
    detail:
      status === 'permissionDenied'
        ? 'Not registered for pages on this phone: notifications are off for Boxalarm.'
        : 'Not registered for pages on this phone yet: pages for you will not ring here. Retrying; it needs signal.',
    ...(status === 'failed' ? { fixLabel: 'Try again', fix: retryPushRegistration } : {}),
  };
}

/**
 * The checks that would stop a page waking the member - what the red banner names. A wake-critical
 * check that could not be read counts: "couldn't confirm this phone will ring" is not "ready".
 */
export function blockingReadinessItems(items: readonly ReadinessItem[]): ReadinessItem[] {
  return items.filter(
    (item) => item.wakes && (item.status === 'fail' || item.status === 'unknown'),
  );
}

export interface AlertReadinessState {
  items: ReadinessItem[] | null;
  blocking: ReadinessItem[];
  refresh: () => Promise<void>;
}

/** Re-evaluated on mount and every return to the foreground (the member comes back from Settings). */
export function useAlertReadiness(): AlertReadinessState {
  const [deviceItems, setItems] = useState<ReadinessItem[] | null>(null);
  const memberId = useOptionalAuth()?.memberId ?? null;
  const registration = useSyncExternalStore(subscribePushRegistration, getPushRegistration);

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

  const items = useMemo(
    () =>
      deviceItems && memberId
        ? [registrationReadinessItem(memberId, registration), ...deviceItems]
        : deviceItems,
    [deviceItems, memberId, registration],
  );

  return { items, blocking: items ? blockingReadinessItems(items) : [], refresh };
}
