import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidVisibility,
  TriggerType,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import {
  alertPayloadFromPushData,
  alertPayloadToNotificationData,
  rememberAlertPayload,
} from './alertPayload';
import { ANDROID_RESPONSE_ACTIONS } from './notificationActions';
import { dispatchNotificationId } from './notificationIds';
import {
  categoryFromPushData,
  CRITICAL_CHANNEL_ID,
  DEFAULT_CHANNEL_ID,
  ensureNotificationChannels,
} from './pushChannel';

export interface PushMessageData {
  category?: string;
  dispatchId?: string;
  title?: string;
  body?: string;
  toneSequence?: string;
  [key: string]: unknown;
}

export { dispatchNotificationId } from './notificationIds';

/**
 * The critical channel to post a page on, created if needed. Posting to a channel that does not
 * exist is silently dropped by Android, and the channel id changes when DND access is granted
 * (pushChannel.ts), so this runs before every page rather than trusting app start. Never throws.
 */
async function criticalChannel(): Promise<string> {
  try {
    return await ensureNotificationChannels();
  } catch (error) {
    console.error('[push] ensuring the critical channel before a page failed', error);
    return CRITICAL_CHANNEL_ID;
  }
}

/** a11y-spec §3.1 #2: the alarm sounds "until acknowledged or 60 s". */
export const RING_CAP_MS = 60_000;

/**
 * Cancels the pending 60 s cap for a page - it must never fire after the member answered (it would
 * replace the "Sent" notification with a "stopped ringing" one).
 */
export async function cancelRingCap(dispatchId: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.cancelTriggerNotification(dispatchNotificationId(dispatchId));
  } catch (error) {
    console.warn('[push] cancelling the ring cap failed', error);
  }
}

/** Stops a page ringing: the member acted on it (answered, Silence, or opened it unlocked). */
export async function silenceDispatchNotification(dispatchId: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  await cancelRingCap(dispatchId);
  try {
    await notifee.cancelDisplayedNotification(dispatchNotificationId(dispatchId));
  } catch (error) {
    console.warn('[push] silencing the page notification failed', error);
  }
}

export async function displayPushNotification(
  data: PushMessageData | undefined,
  receivedAt: number = Date.now(),
): Promise<void> {
  if (Platform.OS !== 'android') return;

  const category = categoryFromPushData(data);
  const isCritical = category === 'dispatch';
  const channelId = isCritical ? await criticalChannel() : DEFAULT_CHANNEL_ID;
  // The page travels with the notification, so a tap opens the address with no fetch.
  const payload = isCritical ? alertPayloadFromPushData(data, receivedAt) : null;

  await notifee.displayNotification({
    ...(payload ? { id: dispatchNotificationId(payload.dispatchId) } : {}),
    title: data?.title ?? (isCritical ? 'Dispatch alert' : 'Notification'),
    body: data?.body,
    data: {
      ...(payload ? alertPayloadToNotificationData(payload) : {}),
      dispatchId: data?.dispatchId ?? '',
      category,
    },
    android: {
      channelId,
      importance: isCritical ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
      pressAction: { id: 'default' },
      ...(isCritical
        ? {
            fullScreenAction: { id: 'default' },
            // Alarm category: most OEMs let alarms through Do Not Disturb by default.
            category: AndroidCategory.ALARM,
            // FLAG_INSISTENT: the channel's alarm sound repeats until the member opens,
            // answers or dismisses the page - one chime does not wake a sleeping volunteer.
            loopSound: true,
            autoCancel: false,
            lightUpScreen: true,
            visibility: AndroidVisibility.PUBLIC,
            // Answer from the shade or lock screen without opening the app (same queue).
            ...(payload ? { actions: ANDROID_RESPONSE_ACTIONS } : {}),
          }
        : {}),
    },
  });

  if (payload) await scheduleRingCap(payload, channelId, data);
}

/**
 * After RING_CAP_MS the insistent alarm is replaced, under the same id, by the same page that no
 * longer loops (onlyAlertOnce: the replacement makes no sound). It stays in the shade with its
 * answer buttons. A timestamp trigger without AlarmManager is inexact: under Doze it can fire
 * late, so the cap is "at least 60 s" (runbook row 18). Never throws - the page is already up.
 */
async function scheduleRingCap(
  payload: NonNullable<ReturnType<typeof alertPayloadFromPushData>>,
  channelId: string,
  data: PushMessageData | undefined,
): Promise<void> {
  try {
    await notifee.createTriggerNotification(
      {
        id: dispatchNotificationId(payload.dispatchId),
        title: data?.title ?? 'Dispatch alert',
        body: `${data?.body ?? ''}\nStill unanswered - alarm stopped after 60 s.`.trim(),
        data: { ...alertPayloadToNotificationData(payload), category: 'dispatch' },
        android: {
          channelId,
          importance: AndroidImportance.HIGH,
          pressAction: { id: 'default' },
          category: AndroidCategory.ALARM,
          onlyAlertOnce: true,
          loopSound: false,
          autoCancel: false,
          visibility: AndroidVisibility.PUBLIC,
          actions: ANDROID_RESPONSE_ACTIONS,
        },
      },
      { type: TriggerType.TIMESTAMP, timestamp: Date.now() + RING_CAP_MS },
    );
  } catch (error) {
    console.warn(
      '[push] scheduling the 60 s ring cap failed; the page loops until acted on',
      error,
    );
  }
}

async function rememberPagePayload(
  data: PushMessageData | undefined,
  receivedAt: number,
): Promise<void> {
  if (categoryFromPushData(data) !== 'dispatch') return;
  const payload = alertPayloadFromPushData(data, receivedAt);
  if (payload) await rememberAlertPayload(payload);
}

/**
 * Background-isolate entry for data pushes (wired in index.js). A throw here would silently drop
 * the local display of a dispatch alert with no diagnostic, so it never throws: a failed display is
 * logged and, for a dispatch, retried as a minimal critical-channel notification - no full-screen
 * action (a missing USE_FULL_SCREEN_INTENT grant is a plausible cause of the first failure) and a
 * fresh ensureNotificationChannels() (the channel may not exist yet if the app has not been
 * foregrounded since install).
 */
export async function handleBackgroundPushMessage(
  data: PushMessageData | undefined,
): Promise<void> {
  const receivedAt = Date.now();
  try {
    await displayPushNotification(data, receivedAt);
    return;
  } catch (error) {
    console.error('[push] displaying a background push failed', error);
  } finally {
    // After the display, never before it: a slow cache write must not delay the ring. The
    // cached page is what the Alerts list and the alert screen fall back on offline.
    await rememberPagePayload(data, receivedAt);
  }

  if (categoryFromPushData(data) !== 'dispatch') return;

  try {
    const channelId = await ensureNotificationChannels();
    await notifee.displayNotification({
      title: 'Dispatch alert',
      body: 'Open Boxalarm for details.',
      data: {
        dispatchId: typeof data?.dispatchId === 'string' ? data.dispatchId : '',
        category: 'dispatch',
      },
      android: {
        channelId,
        importance: AndroidImportance.HIGH,
        pressAction: { id: 'default' },
        category: AndroidCategory.ALARM,
        loopSound: true,
      },
    });
  } catch (error) {
    console.error('[push] fallback dispatch notification also failed; alert not displayed', error);
  }
}

/**
 * Foreground entry for data pushes (wired in index.js via onMessage). FCM delivers a data-only
 * message to setBackgroundMessageHandler only while the app is backgrounded or quit; with the
 * app open it goes to onMessage instead, and without this handler a dispatch that arrives while
 * a member has Boxalarm open is never shown. Same fail-safe display path as the background
 * handler, after making sure the channels exist. Never throws.
 */
export async function handleForegroundPushMessage(
  data: PushMessageData | undefined,
): Promise<void> {
  try {
    await ensureNotificationChannels();
  } catch (error) {
    console.error('[push] creating notification channels before a foreground push failed', error);
  }
  await handleBackgroundPushMessage(data);
}
