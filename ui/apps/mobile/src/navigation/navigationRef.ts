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
  if (!navigationRef.isReady()) {
    pendingAlert = payload ? { dispatchId, payload } : { dispatchId };
    return;
  }
  pendingAlert = null;
  navigateNow(dispatchId, payload);
}

/** Wired to NavigationContainer onReady (RootNavigator). */
export function flushPendingAlertNavigation(): void {
  if (!pendingAlert || !navigationRef.isReady()) return;
  const { dispatchId, payload } = pendingAlert;
  pendingAlert = null;
  navigateNow(dispatchId, payload);
}

export function isNavigationReady(): boolean {
  return navigationRef.isReady();
}

/** Calls `listener` whenever the navigation state changes (including when it first mounts). */
export function onNavigationStateChange(listener: () => void): () => void {
  return navigationRef.addListener('state', listener);
}
