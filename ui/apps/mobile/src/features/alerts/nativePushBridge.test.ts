import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import messaging from '@react-native-firebase/messaging';
import { firebaseNativePushBridge } from './nativePushBridge';

jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { CRITICAL_ALERTS_ENTITLEMENT_GRANTED: 'false' },
}));

const requestPermission = notifee.requestPermission as jest.Mock;
const messagingInstance = messaging();

beforeEach(() => {
  requestPermission.mockClear();
  (messagingInstance.getToken as jest.Mock).mockClear();
  (messagingInstance.getAPNSToken as jest.Mock).mockClear();
  (messagingInstance.registerDeviceForRemoteMessages as jest.Mock).mockClear();
});

test('requestPermission asks for the iOS critical-alert option only when the entitlement is granted', async () => {
  requestPermission.mockResolvedValueOnce({ authorizationStatus: 1 });

  const granted = await firebaseNativePushBridge.requestPermission();

  expect(granted).toBe(true);
  expect(requestPermission).toHaveBeenCalledWith({ ios: { critical: false } });
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
  (messagingInstance.getToken as jest.Mock).mockResolvedValueOnce('fcm-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'FCM',
    token: 'fcm-token',
  });
});

test('getToken registers for remote messages then reads the raw APNs token on iOS', async () => {
  Platform.OS = 'ios';
  (messagingInstance.getAPNSToken as jest.Mock).mockResolvedValueOnce('apns-token');

  await expect(firebaseNativePushBridge.getToken()).resolves.toEqual({
    platform: 'APNS',
    token: 'apns-token',
  });
  expect(messagingInstance.registerDeviceForRemoteMessages).toHaveBeenCalled();
});

test('getToken returns null when the platform has not issued a token yet', async () => {
  Platform.OS = 'android';
  (messagingInstance.getToken as jest.Mock).mockResolvedValueOnce(null);
  await expect(firebaseNativePushBridge.getToken()).resolves.toBeNull();
});

test('onTokenRefresh re-reads the platform token and forwards it to the listener', async () => {
  Platform.OS = 'android';
  (messagingInstance.getToken as jest.Mock).mockResolvedValue('rotated-token');
  let refreshCallback: (() => void) | undefined;
  (messagingInstance.onTokenRefresh as jest.Mock).mockImplementationOnce((cb) => {
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
