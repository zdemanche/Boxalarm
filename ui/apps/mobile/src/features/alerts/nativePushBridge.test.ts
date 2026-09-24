import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import * as messaging from '@react-native-firebase/messaging';
import { firebaseNativePushBridge } from './nativePushBridge';

jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { CRITICAL_ALERTS_ENTITLEMENT_GRANTED: 'false' },
}));

const requestPermission = notifee.requestPermission as jest.Mock;
const getToken = messaging.getToken as jest.Mock;
const getAPNSToken = messaging.getAPNSToken as jest.Mock;
const registerDeviceForRemoteMessages = messaging.registerDeviceForRemoteMessages as jest.Mock;
const onTokenRefresh = messaging.onTokenRefresh as jest.Mock;

beforeEach(() => {
  requestPermission.mockClear();
  getToken.mockClear();
  getAPNSToken.mockClear();
  registerDeviceForRemoteMessages.mockClear();
});

test('requestPermission asks for the iOS critical-alert option only when the entitlement is granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 1 });

  const granted = await firebaseNativePushBridge.requestPermission();

  expect(granted).toBe(true);
  expect(requestPermission).toHaveBeenCalledWith({ criticalAlert: false });
});

test('requestPermission treats provisional authorization as granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 2 });
  await expect(firebaseNativePushBridge.requestPermission()).resolves.toBe(true);
});

test('requestPermission treats denial as not granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 0 });
  await expect(firebaseNativePushBridge.requestPermission()).resolves.toBe(false);
});

test('getToken reads the FCM token on Android', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValueOnce('fcm-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'FCM',
    token: 'fcm-token',
  });
});

test('getToken registers for remote messages then reads the raw APNs token on iOS', async () => {
  Platform.OS = 'ios';
  getAPNSToken.mockResolvedValueOnce('apns-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'APNS',
    token: 'apns-token',
  });
  expect(registerDeviceForRemoteMessages).toHaveBeenCalled();
});

test('getToken returns null when the platform has not issued a token yet', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValueOnce(null);
  await expect(firebaseNativePushBridge.getToken()).resolves.toBeNull();
});

test('onTokenRefresh re-reads the platform token and forwards it to the listener', async () => {
  Platform.OS = 'android';
  getToken.mockResolvedValue('rotated-token');
  let refreshCallback: (() => void) | undefined;
  onTokenRefresh.mockImplementationOnce((_instance: unknown, cb: () => void) => {
    refreshCallback = cb;
    return () => {};
  });

  const listener = jest.fn();
  firebaseNativePushBridge.onTokenRefresh(listener);
  refreshCallback?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(listener).toHaveBeenCalledWith({ platform: 'FCM', token: 'rotated-token' });
});
