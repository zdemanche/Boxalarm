import { createNavigationContainerRef } from '@react-navigation/native';
import type { AlertPayload } from '../features/alerts/alertPayload';
import type { AppTabsParamList } from './AppTabs';

export const navigationRef = createNavigationContainerRef<AppTabsParamList>();

// A notification opened before the navigator mounted (Android cold start from a page: the
// initial notification resolves while the keychain is still loading) used to be dropped here.
// It is now held until the container reports ready - the newest one wins.
let pendingAlert: { dispatchId: string; payload?: AlertPayload } | null = null;

function navigateNow(dispatchId: string, payload?: AlertPayload): void {
  navigationRef.navigate('Alerts', {
    screen: 'AlertDetail',
    params: payload ? { dispatchId, payload } : { dispatchId },
  });
}

export function navigateToAlertDetail(dispatchId: string, payload?: AlertPayload): void {
  // Also held while signed out (the sign-in screens have no alert route): it opens after sign-in.
  if (!isAlertRouteAvailable()) {
    pendingAlert = payload ? { dispatchId, payload } : { dispatchId };
    return;
  }
  pendingAlert = null;
  navigateNow(dispatchId, payload);
}

export function hasPendingAlertNavigation(): boolean {
  return pendingAlert !== null;
}

/** Wired to NavigationContainer onReady and onStateChange (RootNavigator). */
export function flushPendingAlertNavigation(): void {
  if (!pendingAlert || !isAlertRouteAvailable()) return;
  const { dispatchId, payload } = pendingAlert;
  pendingAlert = null;
  navigateNow(dispatchId, payload);
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

/** Calls `listener` whenever the navigation state changes (including when it first mounts). */
export function onNavigationStateChange(listener: () => void): () => void {
  return navigationRef.addListener('state', listener);
}
