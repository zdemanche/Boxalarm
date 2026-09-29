import notifee, { EventType } from '@notifee/react-native';
import { AppState, Platform, Settings } from 'react-native';
import {
  getInitialNotification,
  getMessaging,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';
import {
  isNavigationReady,
  navigateToAlertDetail,
  onNavigationStateChange,
} from '../../navigation/navigationRef';
import {
  alertPayloadFromNotificationData,
  alertPayloadFromPushData,
  type AlertPayload,
} from './alertPayload';

const messagingInstance = getMessaging();

export function dispatchIdFromNotificationData(
  data: Record<string, unknown> | undefined,
): string | null {
  const id = data?.dispatchId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Opens the alert screen with the page's own payload, so it paints before any fetch. */
function openAlert(payload: AlertPayload | null): void {
  if (payload) navigateToAlertDetail(payload.dispatchId, payload);
}

/** An FCM RemoteMessage (sentTime in epoch ms), as delivered to the open/initial callbacks. */
function payloadFromRemoteMessage(
  message: { data?: Record<string, unknown>; sentTime?: number } | null | undefined,
): AlertPayload | null {
  return alertPayloadFromPushData(message?.data, message?.sentTime ?? Date.now());
}

async function routeToInitialNotification(): Promise<void> {
  if (Platform.OS === 'android') {
    const initial = await notifee.getInitialNotification();
    openAlert(alertPayloadFromNotificationData(initial?.notification.data));
    return;
  }
  openAlert(payloadFromRemoteMessage(await getInitialNotification(messagingInstance)));
}

/**
 * iOS dispatch pages come straight from APNs, with no FCM marker, so React Native Firebase's
 * getInitialNotification / onNotificationOpenedApp never report a tap on them. AppDelegate's
 * didReceive (ios/Boxalarm/AppDelegate.swift) records the tapped page's dispatchId in
 * NSUserDefaults under this key, as `{ dispatchId, tappedAt, title?, body?, toneSequence? }`
 * (tappedAt in epoch seconds; the rest is the page's own text, so the alert screen paints the
 * address without a fetch). React
 * Native's built-in Settings API reads that key on launch and reports changes while running.
 * That covers cold, background and foreground taps without a custom native module.
 */
export const IOS_PENDING_ALERT_TAP_KEY = 'boxalarm.pendingAlertTap';

/** A recorded tap older than this is from an old call (e.g. the app was killed before it routed). */
export const IOS_PENDING_ALERT_TAP_MAX_AGE_SECONDS = 600;

interface PendingIosTap {
  dispatchId?: unknown;
  tappedAt?: unknown;
  title?: unknown;
  body?: unknown;
  toneSequence?: unknown;
}

function readPendingIosTap(nowMs: number): AlertPayload | null {
  const pending = Settings.get(IOS_PENDING_ALERT_TAP_KEY) as PendingIosTap | null | undefined;
  if (!pending || typeof pending !== 'object') return null;
  const { dispatchId, tappedAt } = pending;
  const fresh =
    typeof tappedAt === 'number' &&
    nowMs / 1000 - tappedAt <= IOS_PENDING_ALERT_TAP_MAX_AGE_SECONDS;
  if (typeof dispatchId !== 'string' || dispatchId.length === 0 || !fresh) {
    Settings.set({ [IOS_PENDING_ALERT_TAP_KEY]: null });
    return null;
  }
  return alertPayloadFromPushData(pending as Record<string, unknown>, (tappedAt as number) * 1000);
}

/**
 * Routes a recorded iOS tap once navigation can take it. A tap recorded before the navigator
 * mounted (cold start) stays pending and is routed on the first navigation state change.
 */
export function routePendingIosAlertTap(nowMs: number = Date.now()): void {
  const payload = readPendingIosTap(nowMs);
  if (!payload || !isNavigationReady()) return;
  Settings.set({ [IOS_PENDING_ALERT_TAP_KEY]: null });
  openAlert(payload);
}

function subscribeIosAlertTaps(): () => void {
  routePendingIosAlertTap();
  const watchId = Settings.watchKeys(IOS_PENDING_ALERT_TAP_KEY, () => routePendingIosAlertTap());
  const unsubscribeNavigation = onNavigationStateChange(() => routePendingIosAlertTap());
  const appState = AppState.addEventListener('change', (status) => {
    if (status === 'active') routePendingIosAlertTap();
  });
  return () => {
    Settings.clearWatch(watchId);
    unsubscribeNavigation();
    appState.remove();
  };
}

export function subscribePushNotificationRouting(): () => void {
  void routeToInitialNotification();

  const unsubscribeOpened = onNotificationOpenedApp(messagingInstance, (remoteMessage) => {
    openAlert(payloadFromRemoteMessage(remoteMessage));
  });

  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type !== EventType.PRESS) return;
    openAlert(alertPayloadFromNotificationData(detail.notification?.data));
  });

  const unsubscribeIosTaps = Platform.OS === 'ios' ? subscribeIosAlertTaps() : () => {};

  return () => {
    unsubscribeOpened();
    unsubscribeForeground();
    unsubscribeIosTaps();
  };
}
