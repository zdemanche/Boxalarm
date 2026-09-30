import notifee, { EventType } from '@notifee/react-native';
import { Alert, AppState, Platform, Settings } from 'react-native';
import {
  getInitialNotification,
  getMessaging,
  onNotificationOpenedApp,
} from '@react-native-firebase/messaging';
import { readStoredSessionOwner } from '../../auth/AuthContext';
import * as syncManager from '../../sync/syncManager';
import {
  isAlertRouteAvailable,
  isNavigationReady,
  navigateToAlertDetail,
  navigateToMutualAidPrompt,
  navigationRef,
  onNavigationStateChange,
} from '../../navigation/navigationRef';
import { queueAlertResponse } from './alertResponses';
import { markInitialAlertRoutingSettled } from './lockScreenPresentation';
import { answerFromActionId, handleNotificationEvent } from './notificationActions';
import { isRingingAlertId } from './notificationIds';
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

/**
 * Opens the alert screen with the page's own payload, so it paints before any fetch - or, for an
 * officer's mutual-aid prompt, the prompt screen with its confirm action.
 */
function openAlert(payload: AlertPayload | null): void {
  if (!payload) return;
  if (payload.mutualAidPrompt) navigateToMutualAidPrompt(payload.dispatchId, payload);
  else navigateToAlertDetail(payload.dispatchId, payload);
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
  /** Epoch seconds the notification was delivered (UNNotification.date). */
  deliveredAt?: unknown;
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
  const receivedSeconds =
    typeof pending.deliveredAt === 'number' ? pending.deliveredAt : (tappedAt as number);
  return alertPayloadFromPushData(pending as Record<string, unknown>, receivedSeconds * 1000);
}

/** What a signed-out member is told when they answer a page from its notification (M2). */
export const SIGNED_OUT_ANSWER_TITLE = "You're signed out on this phone";
export const SIGNED_OUT_ANSWER_MESSAGE =
  'Your answer was not sent. Sign in to answer, or use the radio.';

/**
 * A Responding / Not responding action pressed on an iOS page (AppDelegate records it with the
 * tap). Queued at once, before navigation is ready, through the same outbox as the alert screen;
 * the action is then stripped from the record so a later routing retry cannot answer twice.
 *
 * On a signed-out phone the answer is not queued (M2, the same gate as Android's
 * answerFromNotification): there is no one to send it as, and an ownerless answer would be
 * offered to whoever signs in next. The member is told, and the tap itself stays recorded so the
 * call opens once they sign in. A keychain read error is not "signed out": that answer is queued
 * with the last session's hint, as on Android.
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
  void (async () => {
    if (!syncManager.isConfigured()) {
      const signedOut = await readStoredSessionOwner().then(
        (stored) => stored === null,
        () => false,
      );
      if (signedOut) {
        Alert.alert(SIGNED_OUT_ANSWER_TITLE, SIGNED_OUT_ANSWER_MESSAGE);
        return;
      }
    }
    await queueAlertResponse(dispatchId, answer, null);
  })().catch((error: unknown) => {
    console.error('[push] queueing the answer from an iOS notification action failed', error);
  });
}

/**
 * Routes a recorded iOS tap once navigation can take it. A tap recorded before the navigator
 * mounted (cold start), or while the sign-in screens are showing (no alert screen to open), stays
 * pending and is routed on the first navigation state change that can take it.
 */
export function routePendingIosAlertTap(nowMs: number = Date.now()): void {
  const payload = readPendingIosTap(nowMs);
  if (!payload) return;
  answerPendingIosAction(payload.dispatchId);
  if (!isNavigationReady() || !isAlertRouteAvailable()) return;
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
    if (event.type === EventType.ACTION_PRESS || event.type === EventType.DISMISSED) {
      void handleNotificationEvent(event);
      return;
    }
    if (event.type !== EventType.PRESS) return;
    openAlert(alertPayloadFromNotificationData(event.detail.notification?.data));
  });

  const unsubscribeIosTaps = Platform.OS === 'ios' ? subscribeIosAlertTaps() : () => {};

  const ringingSubscription =
    Platform.OS === 'android'
      ? AppState.addEventListener('change', (status) => {
          if (status === 'active') void routeToRingingPage();
        })
      : null;

  return () => {
    clearTimeout(grace);
    unsubscribeOpened();
    unsubscribeForeground();
    unsubscribeIosTaps();
    ringingSubscription?.remove();
  };
}

// Notification ids already routed to by routeToRingingPage, so returning to the app does not
// pull the member back to the same page again and again.
const routedRingingPages = new Set<string>();

/**
 * Review m2-1 / round 3 K3-5 (Android): a full-screen page that reaches an app already running on
 * another tab may raise no press event, leaving that tab over the keyguard. When the app becomes
 * active while a page is still showing on the critical channel (ringing or capped - an answered
 * page is replaced on the default channel), open the newest such call, once per notification.
 */
export async function routeToRingingPage(): Promise<void> {
  if (Platform.OS !== 'android') return;
  let shown: Awaited<ReturnType<typeof notifee.getDisplayedNotifications>>;
  try {
    shown = await notifee.getDisplayedNotifications();
  } catch (error) {
    console.warn('[push] reading the showing notifications failed', error);
    return;
  }
  const ringing = shown
    .filter((entry) => {
      const id = entry.id ?? entry.notification?.id ?? '';
      const channel = entry.notification?.android?.channelId ?? '';
      return isRingingAlertId(id) && channel.startsWith('dispatch-critical');
    })
    .sort((a, b) => Number(b.date ?? 0) - Number(a.date ?? 0));
  const newest = ringing[0];
  const id = newest?.id ?? newest?.notification?.id;
  if (!newest || !id || routedRingingPages.has(id)) return;
  const payload = alertPayloadFromNotificationData(newest.notification?.data);
  if (!payload) return;
  routedRingingPages.add(id);
  const current = navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined;
  const onIt =
    current?.name === (payload.mutualAidPrompt ? 'MutualAidPrompt' : 'AlertDetail') &&
    (current.params as { dispatchId?: string } | undefined)?.dispatchId === payload.dispatchId;
  if (!onIt) openAlert(payload);
}

/** Test seam. */
export function resetRoutedRingingPagesForTest(): void {
  routedRingingPages.clear();
}
