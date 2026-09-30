import { hasPendingAlertNavigation, navigationRef } from '../../navigation/navigationRef';
import { setAlertShowsOverLockScreen } from './alertReadiness';

/**
 * Who owns "show over the lock screen" (review CR-2). Native turns it on when a launch arrives
 * while the keyguard is up (MainActivity - the full-screen page); the alert screen turns it on
 * whenever it is focused; and ONLY this navigation-state check turns it off, when no alert is
 * focused. Clearing on an alert screen's blur/unmount raced a second page on a locked phone: the
 * old screen's cleanup ran after the new page's intent and sent the new page behind the keyguard.
 *
 * Nothing is cleared until the launch's initial notification has been routed, so a cold start
 * from a full-screen page is not hidden before its alert screen mounts.
 */
let initialRoutingSettled = false;

export const ALERT_ROUTE_NAME = 'AlertDetail';

export function syncLockScreenPresentation(): void {
  if (!initialRoutingSettled || hasPendingAlertNavigation() || !navigationRef.isReady()) return;
  if (navigationRef.getCurrentRoute()?.name !== ALERT_ROUTE_NAME) {
    setAlertShowsOverLockScreen(false);
  }
}

export function markInitialAlertRoutingSettled(): void {
  initialRoutingSettled = true;
  syncLockScreenPresentation();
}

/** Test seam. */
export function resetLockScreenPresentationForTest(): void {
  initialRoutingSettled = false;
}
