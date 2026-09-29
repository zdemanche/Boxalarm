import notifee, {
  AndroidImportance,
  EventType,
  type AndroidAction,
  type Event,
  type IOSNotificationCategory,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import Config from 'react-native-config';
import { createStoredTokenSource } from '../../auth/AuthContext';
import * as syncManager from '../../sync/syncManager';
import { ackStatusLabel } from './ackStatus';
import { alertPayloadFromNotificationData } from './alertPayload';
import { etaFor, queueAlertResponse, type ResponseAnswer } from './alertResponses';
import { DEFAULT_CHANNEL_ID } from './pushChannel';

/** The action ids a page's notification carries; the same ids on Android and iOS. */
const RESPOND_PREFIX = 'respond:';
const ACTION_ANSWERS: readonly ResponseAnswer[] = ['RESPONDING', 'NOT_RESPONDING'];

export function answerFromActionId(actionId: string | undefined): ResponseAnswer | null {
  if (!actionId?.startsWith(RESPOND_PREFIX)) return null;
  const answer = actionId.slice(RESPOND_PREFIX.length) as ResponseAnswer;
  return ACTION_ANSWERS.includes(answer) ? answer : null;
}

/** Android: shade / lock-screen buttons, handled headlessly (no launchActivity - no unlock). */
export const ANDROID_RESPONSE_ACTIONS: AndroidAction[] = [
  { title: 'Responding', pressAction: { id: `${RESPOND_PREFIX}RESPONDING` } },
  { title: 'Not responding', pressAction: { id: `${RESPOND_PREFIX}NOT_RESPONDING` } },
];

/**
 * iOS: the category a dispatch page must name in `aps.category` for its actions to show. The
 * alerting service does not send it yet (pushPayload.ts buildApnsPayload) - until it does, iOS
 * pages show no buttons. `foreground: true` opens Boxalarm (after unlock) so the answer goes
 * through the same queue with the alert screen showing whether it was sent; answering without
 * unlocking would need a native, JS-free sender in AppDelegate.
 */
export const IOS_DISPATCH_CATEGORY_ID = 'DISPATCH';
export const IOS_DISPATCH_CATEGORY: IOSNotificationCategory = {
  id: IOS_DISPATCH_CATEGORY_ID,
  actions: [
    { id: `${RESPOND_PREFIX}RESPONDING`, title: 'Responding', foreground: true },
    {
      id: `${RESPOND_PREFIX}NOT_RESPONDING`,
      title: 'Not responding',
      foreground: true,
      destructive: true,
    },
  ],
};

export async function registerNotificationCategories(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await notifee.setNotificationCategories([IOS_DISPATCH_CATEGORY]);
  } catch (error) {
    console.error('[push] registering the iOS dispatch category failed', error);
  }
}

/** A headless task has no AuthProvider: point the outbox at the stored session if nothing has. */
function ensureSyncConfigured(): void {
  if (syncManager.isConfigured()) return;
  const apiBaseUrl = Config.API_BASE_URL;
  if (!apiBaseUrl) return;
  syncManager.configure(createStoredTokenSource(), apiBaseUrl);
}

async function showAnswerNotification(
  notificationId: string,
  data: Record<string, string>,
  answer: ResponseAnswer,
  body: string,
): Promise<void> {
  await notifee.displayNotification({
    id: notificationId,
    title: `${ackStatusLabel(answer)} — ${data.incidentType ?? 'Dispatch'}`,
    body,
    data,
    android: {
      channelId: DEFAULT_CHANNEL_ID,
      importance: AndroidImportance.DEFAULT,
      pressAction: { id: 'default' },
      onlyAlertOnce: true,
    },
  });
}

/**
 * Answers a page from its notification through the same queued path as the alert screen, then
 * replaces the ringing notification with one that says honestly where the answer is: sent, or
 * saved on the phone and not sent yet. Never throws (it runs in a background task).
 */
export async function answerFromNotification(
  notificationId: string,
  rawData: Record<string, unknown> | undefined,
  answer: ResponseAnswer,
): Promise<void> {
  const payload = alertPayloadFromNotificationData(rawData);
  if (!payload) return;
  const data = Object.fromEntries(
    Object.entries(rawData ?? {}).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
  try {
    ensureSyncConfigured();
    const outboxId = await queueAlertResponse(
      payload.dispatchId,
      answer,
      etaFor(answer, undefined),
    );
    await showAnswerNotification(notificationId, data, answer, 'Saved on this phone. Sending…');
    await syncManager.drainAndSettle();
    const sent = syncManager.hasSynced(outboxId);
    await showAnswerNotification(
      notificationId,
      data,
      answer,
      sent
        ? 'Sent. The officer can see your answer. Tap to open the call.'
        : 'NOT SENT YET - saved on this phone and it sends when you have signal. Tap to check.',
    );
  } catch (error) {
    console.error('[push] answering from the notification failed', error);
    try {
      await showAnswerNotification(
        notificationId,
        data,
        answer,
        'Could not save your answer. Open Boxalarm and answer there, or use the radio.',
      );
    } catch {
      // Nothing else can be shown from here.
    }
  }
}

/** notifee event handler for both onBackgroundEvent (index.js) and onForegroundEvent. */
export async function handleNotificationEvent({ type, detail }: Event): Promise<void> {
  if (type !== EventType.ACTION_PRESS) return;
  const answer = answerFromActionId(detail.pressAction?.id);
  const notification = detail.notification;
  if (!answer || !notification?.id) return;
  await answerFromNotification(notification.id, notification.data, answer);
}
