import { createNavigationContainerRef } from '@react-navigation/native';
import type { AlertPayload } from '../features/alerts/alertPayload';
import type { AppTabsParamList } from './AppTabs';

export const navigationRef = createNavigationContainerRef<AppTabsParamList>();

// A notification opened before the navigator mounted (Android cold start from a page: the
// initial notification resolves while the keychain is still loading) used to be dropped here.
// It is now held until the container reports ready - the newest one wins.
type AlertScreen = 'AlertDetail' | 'MutualAidPrompt';

/**
 * A page held for after sign-in is dropped once its call is this old (N-m6) - the same 2 h window
 * the phone keeps pages and ownerless answers for - so the next sign-in, maybe hours later and
 * maybe another member, does not open on a call long over. Timed from the dispatch, else from when
 * the phone received the page, else from when it was held.
 */
export const HELD_ALERT_MAX_AGE_MS = 2 * 60 * 60_000;

let pendingAlert: {
  screen: AlertScreen;
  dispatchId: string;
  payload?: AlertPayload;
  heldAt: number;
} | null = null;

function isStale(held: NonNullable<typeof pendingAlert>, now: number): boolean {
  const since = held.payload?.dispatchedAt ?? held.payload?.receivedAt ?? held.heldAt;
  return now - since > HELD_ALERT_MAX_AGE_MS;
}

function navigateNow(screen: AlertScreen, dispatchId: string, payload?: AlertPayload): void {
  navigationRef.navigate('Alerts', {
    screen,
    params: payload ? { dispatchId, payload } : { dispatchId },
  });
}

function navigateOrHold(screen: AlertScreen, dispatchId: string, payload?: AlertPayload): void {
  // Also held while signed out (the sign-in screens have no alert route): it opens after sign-in.
  if (!isAlertRouteAvailable()) {
    const heldAt = Date.now();
    pendingAlert = payload
      ? { screen, dispatchId, payload, heldAt }
      : { screen, dispatchId, heldAt };
    return;
  }
  pendingAlert = null;
  navigateNow(screen, dispatchId, payload);
}

export function navigateToAlertDetail(dispatchId: string, payload?: AlertPayload): void {
  navigateOrHold('AlertDetail', dispatchId, payload);
}

/** The officer's mutual-aid prompt for a call (a push with alertKind mutual_aid_prompt). */
export function navigateToMutualAidPrompt(dispatchId: string, payload?: AlertPayload): void {
  navigateOrHold('MutualAidPrompt', dispatchId, payload);
}

export function hasPendingAlertNavigation(): boolean {
  return pendingAlert !== null;
}

// A non-critical notification tap (category 'digest') held until the signed-in tabs exist,
// like a page — but it only ever opens the inbox, never an alert screen.
let pendingInboxHeldAt: number | null = null;

/**
 * Opens Me > Inbox — the destination of every notification-service push tap
 * (pushRouting.ts). Held like an alert while the tabs are not mounted yet (cold start,
 * sign-in screens), and dropped on the same 2 h staleness window.
 */
export function navigateToInbox(): void {
  if (!isInboxRouteAvailable()) {
    pendingInboxHeldAt = Date.now();
    return;
  }
  pendingInboxHeldAt = null;
  navigationRef.navigate('Me', { screen: 'Inbox' });
}

/** Wired to NavigationContainer onReady and onStateChange (RootNavigator). */
export function flushPendingAlertNavigation(): void {
  // Inbox first, alert second: when both are held, the call must end up on top.
  if (pendingInboxHeldAt !== null && isInboxRouteAvailable()) {
    const heldAt = pendingInboxHeldAt;
    pendingInboxHeldAt = null;
    if (Date.now() - heldAt <= HELD_ALERT_MAX_AGE_MS) {
      navigationRef.navigate('Me', { screen: 'Inbox' });
    }
  }
  if (!pendingAlert || !isAlertRouteAvailable()) return;
  const held = pendingAlert;
  pendingAlert = null;
  if (isStale(held, Date.now())) return;
  navigateNow(held.screen, held.dispatchId, held.payload);
}

export function isNavigationReady(): boolean {
  return navigationRef.isReady();
}

/**
 * Whether the navigator holds the app tabs (a signed-in session), so an alert screen can open.
 * While the sign-in screens are showing the container is ready but has no Alerts route.
 */
export function isAlertRouteAvailable(): boolean {
  if (!navigationRef.isReady()) return false;
  return navigationRef.getRootState()?.routeNames?.includes('Alerts') ?? false;
}

/** Whether the Me tab (and so the Inbox screen) is mounted — the signed-in tabs. */
export function isInboxRouteAvailable(): boolean {
  if (!navigationRef.isReady()) return false;
  return navigationRef.getRootState()?.routeNames?.includes('Me') ?? false;
}

/** Calls `listener` whenever the navigation state changes (including when it first mounts). */
export function onNavigationStateChange(listener: () => void): () => void {
  return navigationRef.addListener('state', listener);
}
