import notifee, { AndroidImportance, AndroidVisibility } from '@notifee/react-native';
import { Platform } from 'react-native';
import { kvGet, kvSet } from '../../sync/kvStore';
import { alertReadinessNative } from './alertReadiness';

/**
 * Android channels are immutable once created, and `bypassDnd` only takes effect if the app held
 * Do Not Disturb (notification policy) access when the channel was created. So the critical
 * channel id is versioned and depends on that access: `-v2` is created without it, `-v2-dnd`
 * after it is granted, and the other one is deleted. The original `dispatch-critical` was always
 * created before any grant (its bypass silently ignored) with a one-shot default chime; it is
 * deleted so a member's old mute on it cannot follow them.
 */
export const CRITICAL_CHANNEL_ID = 'dispatch-critical-v2';
export const CRITICAL_CHANNEL_DND_ID = 'dispatch-critical-v2-dnd';
const RETIRED_CRITICAL_CHANNEL_IDS = ['dispatch-critical'];
export const DEFAULT_CHANNEL_ID = 'notifications-default';
const CRITICAL_CHANNEL_NAME = 'Dispatch pages';

export type PushCategory = 'dispatch' | 'digest';

/**
 * Deliberate fail-loud default: anything other than an explicit `'digest'` (missing, misspelled,
 * or a future category) is treated as a dispatch and routed to the critical DND-bypass channel.
 * A non-urgent notice that is too loud is recoverable; a dispatch that arrives silently is not.
 */
export function categoryFromPushData(data: { category?: unknown } | undefined): PushCategory {
  return data?.category === 'digest' ? 'digest' : 'dispatch';
}

// The id last resolved from a successful DND-access read. A transient read error keeps it rather
// than flipping to `-v2` (review m1): flipping would recreate a deleted id - and Android restores
// a re-created channel id with the member's old settings for it, muted or not.
// Persisted (round 2 m2-3): a fresh process - e.g. the headless task for a page - whose first
// read fails must not fall back to `-v2` either.
let lastKnownCriticalId: string | null = null;
const LAST_CRITICAL_CHANNEL_KEY = 'critical-channel-id';

/** The critical channel id this device should post on right now. Never throws. */
export async function currentCriticalChannelId(): Promise<string> {
  const native = alertReadinessNative();
  if (!native) return CRITICAL_CHANNEL_ID;
  try {
    const { dndAccessGranted } = await native.getReadiness();
    const id = dndAccessGranted ? CRITICAL_CHANNEL_DND_ID : CRITICAL_CHANNEL_ID;
    if (id !== lastKnownCriticalId) {
      lastKnownCriticalId = id;
      await kvSet(LAST_CRITICAL_CHANNEL_KEY, id);
    }
    return id;
  } catch {
    if (!lastKnownCriticalId) {
      lastKnownCriticalId = (await kvGet<string>(LAST_CRITICAL_CHANNEL_KEY))?.value ?? null;
    }
    return lastKnownCriticalId ?? CRITICAL_CHANNEL_ID;
  }
}

/**
 * Deleting a channel removes the notifications posted on it - including a page that is ringing
 * right now (round 2 m2-3). Stale channels are only deleted when no dispatch page is showing; if
 * that cannot be read, deletion waits for the next foreground.
 */
async function aDispatchPageIsShowing(): Promise<boolean> {
  try {
    const shown = await notifee.getDisplayedNotifications();
    return shown.some((entry) =>
      (entry.id ?? entry.notification?.id ?? '').startsWith('dispatch:'),
    );
  } catch {
    return true;
  }
}

/** Test seam: forgets the in-memory id (a fresh process); the persisted one stays. */
export function resetCriticalChannelIdForTest(): void {
  lastKnownCriticalId = null;
}

export async function channelForCategory(category: PushCategory): Promise<string> {
  return category === 'dispatch' ? currentCriticalChannelId() : DEFAULT_CHANNEL_ID;
}

export interface EnsureChannelsOptions {
  /**
   * Delete the superseded critical channels. Only on app start / return to the foreground
   * (usePushNotificationRouting) - never on the page path, where a delete could remove the channel
   * a concurrently arriving page is being posted to (review m1).
   */
  deleteStale?: boolean;
}

/**
 * Creates the channels. Safe to call repeatedly: the critical channel is (re)created under the id
 * that matches the current DND access, so granting access in Settings takes effect as soon as the
 * member returns. Creating an existing channel is a no-op for its settings, so calling this before
 * every page guarantees the channel exists without resetting anything the member chose.
 * Resolves with the critical channel id to post on.
 */
export function ensureNotificationChannels(options: EnsureChannelsOptions = {}): Promise<string> {
  const creating = createNotificationChannels(options);
  lastChannelSetup = creating;
  return creating;
}

let lastChannelSetup: Promise<string> | null = null;

/**
 * Resolves once the channel setup already started has finished (m8): readiness reads the
 * critical channel only after it, so returning from Settings with Do Not Disturb access just
 * granted does not flag the -dnd channel as "not set up yet" while it is being created. Waits a
 * turn first, so a setup started by another listener of the same foreground event is included.
 */
export async function notificationChannelsSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await lastChannelSetup?.catch(() => undefined);
}

async function createNotificationChannels(options: EnsureChannelsOptions): Promise<string> {
  if (Platform.OS !== 'android') return CRITICAL_CHANNEL_ID;
  const native = alertReadinessNative();
  let criticalId = CRITICAL_CHANNEL_ID;

  let createdNatively = false;
  if (native) {
    // The system ALARM sound on the alarm stream: no fire-tone asset exists in this repo (see
    // AlertReadinessModule.kt). Created natively because notifee can only name res/raw sounds.
    try {
      criticalId = await currentCriticalChannelId();
      await native.createCriticalChannel(criticalId, CRITICAL_CHANNEL_NAME);
      createdNatively = true;
      if (options.deleteStale && !(await aDispatchPageIsShowing())) {
        const stale = [
          ...RETIRED_CRITICAL_CHANNEL_IDS,
          criticalId === CRITICAL_CHANNEL_ID ? CRITICAL_CHANNEL_DND_ID : CRITICAL_CHANNEL_ID,
        ];
        await Promise.all(stale.map((id) => native.deleteChannel(id)));
      }
    } catch (error) {
      console.error('[push] creating the native critical channel failed; using notifee', error);
    }
  }
  if (!createdNatively) {
    // A page must never be posted to a channel that does not exist (Android drops it).
    criticalId = CRITICAL_CHANNEL_ID;
    await notifee.createChannel({
      id: CRITICAL_CHANNEL_ID,
      name: CRITICAL_CHANNEL_NAME,
      importance: AndroidImportance.HIGH,
      bypassDnd: true,
      sound: 'default',
      vibration: true,
      visibility: AndroidVisibility.PUBLIC,
    });
  }

  await notifee.createChannel({
    id: DEFAULT_CHANNEL_ID,
    name: 'Notifications',
    importance: AndroidImportance.DEFAULT,
    bypassDnd: false,
  });
  return criticalId;
}
