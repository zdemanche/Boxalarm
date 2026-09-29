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
import { etaFor, queueAlertResponse } from './alertResponses';
import { markInitialAlertRoutingSettled } from './lockScreenPresentation';
import { answerFromActionId, handleNotificationEvent } from './notificationActions';
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
  /** A notification action ("respond:RESPONDING") pressed instead of a plain tap. */
  action?: unknown;
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
 * A Responding / Not responding action pressed on an iOS page (AppDelegate records it with the
 * tap). Queued at once, before navigation is ready, through the same outbox as the alert screen;
 * the action is then stripped from the record so a later routing retry cannot answer twice.
 */
function answerPendingIosAction(dispatchId: string): void {
  const pending = Settings.get(IOS_PENDING_ALERT_TAP_KEY) as PendingIosTap | null | undefined;
  const answer = answerFromActionId(
    typeof pending?.action === 'string' ? pending.action : undefined,
  );
  if (!pending || !answer) return;
  const rest: PendingIosTap = { ...pending };
  delete rest.action;
  Settings.set({ [IOS_PENDING_ALERT_TAP_KEY]: rest });
  queueAlertResponse(dispatchId, answer, etaFor(answer, undefined)).catch((error: unknown) => {
    console.error('[push] queueing the answer from an iOS notification action failed', error);
  });
}

/**
 * Routes a recorded iOS tap once navigation can take it. A tap recorded before the navigator
 * mounted (cold start) stays pending and is routed on the first navigation state change.
 */
export function routePendingIosAlertTap(nowMs: number = Date.now()): void {
  const payload = readPendingIosTap(nowMs);
  if (!payload) return;
  answerPendingIosAction(payload.dispatchId);
  if (!isNavigationReady()) return;
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

/** If the initial notification never resolves, stop holding the lock-screen flag after this. */
const INITIAL_ROUTING_GRACE_MS = 5_000;

export function subscribePushNotificationRouting(): () => void {
  const grace = setTimeout(markInitialAlertRoutingSettled, INITIAL_ROUTING_GRACE_MS);
  routeToInitialNotification()
    .catch((error: unknown) =>
      console.error('[push] routing the launch notification failed', error),
    )
    .finally(() => {
      clearTimeout(grace);
      markInitialAlertRoutingSettled();
    });

  const unsubscribeOpened = onNotificationOpenedApp(messagingInstance, (remoteMessage) => {
    openAlert(payloadFromRemoteMessage(remoteMessage));
  });

  const unsubscribeForeground = notifee.onForegroundEvent((event) => {
    if (event.type === EventType.ACTION_PRESS) {
      void handleNotificationEvent(event);
      return;
    }
    if (event.type !== EventType.PRESS) return;
    openAlert(alertPayloadFromNotificationData(event.detail.notification?.data));
  });

  const unsubscribeIosTaps = Platform.OS === 'ios' ? subscribeIosAlertTaps() : () => {};

  return () => {
    clearTimeout(grace);
    unsubscribeOpened();
    unsubscribeForeground();
    unsubscribeIosTaps();
  };
}
