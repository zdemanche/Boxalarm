import notifee, {
  AndroidImportance,
  EventType,
  type AndroidAction,
  type Event,
  type IOSNotificationCategory,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import Config from 'react-native-config';
import { createStoredTokenSource, readStoredSessionOwner } from '../../auth/AuthContext';
import * as outbox from '../../sync/outbox';
import * as syncManager from '../../sync/syncManager';
import { RESPONSE_NOT_RECORDED, RESPONSE_SUPERSEDED } from '../../sync/syncManager';
import { ackStatusLabel } from './ackStatus';
import {
  alertPayloadFromNotificationData,
  alertPayloadToNotificationData,
  cachedAlertPayload,
} from './alertPayload';
import { queueAlertResponse, type ResponseAnswer } from './alertResponses';
import { DEFAULT_CHANNEL_ID } from './pushChannel';
import { dispatchNotificationId } from './notificationIds';

/** The action ids a page's notification carries; the same ids on Android and iOS. */
const RESPOND_PREFIX = 'respond:';
const ACTION_ANSWERS: readonly ResponseAnswer[] = [
  'RESPONDING',
  'DIRECT_TO_SCENE',
  'NOT_RESPONDING',
];

export function answerFromActionId(actionId: string | undefined): ResponseAnswer | null {
  if (!actionId?.startsWith(RESPOND_PREFIX)) return null;
  const answer = actionId.slice(RESPOND_PREFIX.length) as ResponseAnswer;
  return ACTION_ANSWERS.includes(answer) ? answer : null;
}

/** Android: shade / lock-screen buttons, handled headlessly (no launchActivity - no unlock). */
// Android shows at most three actions, so there is no Silence button here: dismissing the page,
// opening it, or the 60 s cap stops the alarm, and the alert screen has a Silence button.
export const ANDROID_RESPONSE_ACTIONS: AndroidAction[] = [
  { title: 'Responding', pressAction: { id: `${RESPOND_PREFIX}RESPONDING` } },
  { title: 'Direct to scene', pressAction: { id: `${RESPOND_PREFIX}DIRECT_TO_SCENE` } },
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
    { id: `${RESPOND_PREFIX}DIRECT_TO_SCENE`, title: 'Direct to scene', foreground: true },
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

// Work queued anywhere without an AuthProvider-configured owner (this headless task, a cold
// start) resolves its owner from the stored session instead of being stamped blank (R3-C1).
syncManager.setOwnerResolver(() => readStoredSessionOwner());

// An ownerless answer too old for its call is dropped by the outbox; the page's own time (the
// server's dispatch time, else when it arrived) is the second clock, and the notification that
// last said "NOT SENT YET" must now say it never will be.
syncManager.setStaleAnswerHooks({
  async pageTime(dispatchId) {
    const payload = await cachedAlertPayload(dispatchId);
    return payload ? (payload.dispatchedAt ?? payload.receivedAt) : null;
  },
  async onDropped(dispatchId) {
    const payload = await cachedAlertPayload(dispatchId);
    await notifee.displayNotification({
      id: dispatchNotificationId(dispatchId),
      title: `Answer not sent — ${payload?.incidentType ?? 'Dispatch'}`,
      body: 'Not sent: this call is over. Tell your officer if you responded.',
      data: payload ? alertPayloadToNotificationData(payload) : { dispatchId },
      android: {
        channelId: DEFAULT_CHANNEL_ID,
        importance: AndroidImportance.DEFAULT,
        pressAction: { id: 'default' },
        onlyAlertOnce: true,
      },
    });
  },
});

/**
 * Answers whose notification last said they were not sent yet, by outbox id. A later run - the
 * app's own session, once it has loaded - may send them; the notification must then say so
 * rather than keep telling the member it was not sent (m2).
 */
const notSentNotices = new Map<
  string,
  { notificationId: string; data: Record<string, string>; answer: ResponseAnswer }
>();

syncManager.setDeliveredHook((row) => {
  const notice = notSentNotices.get(row.id);
  if (!notice) return;
  notSentNotices.delete(row.id);
  void showAnswerNotification(
    notice.notificationId,
    notice.data,
    notice.answer,
    'Sent. Tap to open the call.',
  ).catch((error: unknown) =>
    console.warn('[push] updating the answer notification failed', error),
  );
});

/**
 * A headless task has no AuthProvider: point the outbox at the stored session if nothing has,
 * with the member and department it belongs to, so the answer is stamped as theirs (R3-C1).
 */
async function ensureSyncConfigured(): Promise<void> {
  if (syncManager.isConfigured()) return;
  const apiBaseUrl = Config.API_BASE_URL;
  if (!apiBaseUrl) return;
  const owner = await readStoredSessionOwner().catch(() => null);
  if (syncManager.isConfigured()) return;
  syncManager.configure(
    {
      ...createStoredTokenSource(),
      memberId: owner?.memberId ?? null,
      deptId: owner?.deptId ?? null,
    },
    apiBaseUrl,
  );
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
    // The 60 s cap must not later overwrite the answer notification.
    await notifee
      .cancelTriggerNotification(dispatchNotificationId(payload.dispatchId))
      .catch((error: unknown) => console.warn('[push] cancelling the ring cap failed', error));
    // No stored session means nobody is signed in on this phone: there is no one to send the
    // answer as, and queuing it would credit it to whoever signs in next (R4-M1). Say so instead.
    // A keychain read error is not "signed out": that answer is queued, ownerless, with a hint.
    if (!syncManager.isConfigured()) {
      const signedOut = await readStoredSessionOwner().then(
        (stored) => stored === null,
        () => false,
      );
      if (signedOut) {
        await showAnswerNotification(
          notificationId,
          data,
          answer,
          "You're signed out on this phone. Open Boxalarm and sign in to answer, or use the radio.",
        );
        return;
      }
    }
    await ensureSyncConfigured();
    const outboxId = await queueAlertResponse(payload.dispatchId, answer, null);
    await showAnswerNotification(notificationId, data, answer, 'Saved on this phone. Sending…');
    await syncManager.drainAndSettle();
    const sent = syncManager.hasSynced(outboxId);
    const row = sent ? undefined : await outbox.find(outboxId);
    if (row && row.status !== 'REJECTED') {
      notSentNotices.set(outboxId, { notificationId, data, answer });
    }
    // Sent by another run in the meantime (the delivered hook had nothing to correct yet).
    const sentNow = sent || syncManager.hasSynced(outboxId);
    if (sentNow) notSentNotices.delete(outboxId);
    await showAnswerNotification(
      notificationId,
      data,
      answer,
      sentNow
        ? 'Sent. Tap to open the call.'
        : row?.status === 'REJECTED'
          ? row.lastError === RESPONSE_SUPERSEDED
            ? 'A NEWER ANSWER is already on the roster. Tap to see it and send yours again if needed.'
            : row.lastError === RESPONSE_NOT_RECORDED
              ? 'NOT ON THE ROSTER - the server did not record it. Tap to send again, or use the radio.'
              : 'REFUSED by the server - not recorded. Tap to open the call, or use the radio.'
          : row?.ownerMemberId === null
            ? // Queued without an owner (the keychain could not be read): it sends only once the
              // member's own session is open on this phone, not merely when signal returns (m4).
              'NOT SENT YET - saved on this phone. Open Boxalarm to send it, or use the radio.'
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
  // A page the member swiped away must not come back from the 60 s ring cap (round 2 m2-4): the
  // call is still in the Alerts list, and dismissing is a deliberate act.
  if (type === EventType.DISMISSED) {
    const id = detail.notification?.id;
    if (id?.startsWith('dispatch:')) {
      await notifee
        .cancelTriggerNotification(id)
        .catch((error: unknown) => console.warn('[push] cancelling the ring cap failed', error));
    }
    return;
  }
  if (type !== EventType.ACTION_PRESS) return;
  const answer = answerFromActionId(detail.pressAction?.id);
  const notification = detail.notification;
  if (!answer || !notification?.id) return;
  await answerFromNotification(notification.id, notification.data, answer);
}
