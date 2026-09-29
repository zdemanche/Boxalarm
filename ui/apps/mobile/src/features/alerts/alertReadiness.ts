import { Alert, NativeModules, Platform } from 'react-native';

/** android/app/src/main/java/com/boxalarm/mobile/AlertReadinessModule.kt */
interface AlertReadinessNative {
  getReadiness(): Promise<{
    dndAccessGranted: boolean;
    fullScreenIntentAllowed: boolean;
    sdkInt: number;
  }>;
  getChannelBypassDnd(channelId: string): Promise<boolean | null>;
  createCriticalChannel(channelId: string, name: string): Promise<boolean>;
  deleteChannel(channelId: string): Promise<void>;
  openDndAccessSettings(): Promise<boolean>;
  openFullScreenIntentSettings(): Promise<boolean>;
  setShowWhenLocked(show: boolean): void;
  isKeyguardLocked(): Promise<boolean>;
}

/** Null on iOS, and on an Android build without the module (e.g. Jest). */
export function alertReadinessNative(): AlertReadinessNative | null {
  if (Platform.OS !== 'android') return null;
  const module = (NativeModules as { BoxalarmAlertReadiness?: AlertReadinessNative })
    .BoxalarmAlertReadiness;
  return module ?? null;
}

export interface AndroidDeviceReadiness {
  dndAccessGranted: boolean;
  fullScreenIntentAllowed: boolean;
  sdkInt: number;
}

/** Never throws: an unreadable state is reported as unknown (null), not as fine. */
export async function readAndroidDeviceReadiness(): Promise<AndroidDeviceReadiness | null> {
  const native = alertReadinessNative();
  if (!native) return null;
  try {
    return await native.getReadiness();
  } catch (error) {
    console.warn('[readiness] reading Android alert readiness failed', error);
    return null;
  }
}

/**
 * The guided path to Do Not Disturb access: say what to tap before sending the member to a
 * settings list that does not say why they are there. The critical channel is recreated when
 * the app returns to the foreground (usePushNotificationRouting), because a channel's DND bypass
 * only takes effect if the access was held when the channel was created.
 */
export function guideToDndAccess(): void {
  const native = alertReadinessNative();
  if (!native) return;
  Alert.alert(
    'Let Boxalarm ring through Do Not Disturb',
    'Without this, a page at night is silent whenever Do Not Disturb or Bedtime mode is on.\n\nOn the next screen, tap Boxalarm, turn on "Allow Do Not Disturb", then come back.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open settings', onPress: () => void native.openDndAccessSettings() },
    ],
  );
}

/** Android 14+: full-screen pages are not granted by default to apps that are not phone/alarm apps. */
export function guideToFullScreenIntent(): void {
  const native = alertReadinessNative();
  if (!native) return;
  Alert.alert(
    'Let Boxalarm open full screen on the lock screen',
    'Without this, a page shows as a small banner that disappears after about a minute instead of taking over the screen.\n\nOn the next screen, turn on "Allow full screen notifications" for Boxalarm, then come back.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open settings', onPress: () => void native.openFullScreenIntentSettings() },
    ],
  );
}

/** The alert screen shows over the keyguard; nothing else in the app should (MainActivity). */
export function setAlertShowsOverLockScreen(show: boolean): void {
  try {
    alertReadinessNative()?.setShowWhenLocked(show);
  } catch (error) {
    console.warn('[readiness] setShowWhenLocked failed', error);
  }
}

/** True/false on Android with the module; null when it cannot be known (iOS, no module, error). */
export async function isDeviceLocked(): Promise<boolean | null> {
  const native = alertReadinessNative();
  if (!native) return null;
  try {
    return await native.isKeyguardLocked();
  } catch (error) {
    console.warn('[readiness] reading the keyguard state failed', error);
    return null;
  }
}
