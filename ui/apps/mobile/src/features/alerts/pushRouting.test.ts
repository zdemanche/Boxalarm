import { Platform } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import messaging from '@react-native-firebase/messaging';
import { navigateToAlertDetail } from '../../navigation/navigationRef';
import { dispatchIdFromNotificationData, subscribePushNotificationRouting } from './pushRouting';

const messagingInstance = messaging();

jest.mock('../../navigation/navigationRef', () => ({
  navigateToAlertDetail: jest.fn(),
}));

beforeEach(() => {
  (navigateToAlertDetail as jest.Mock).mockClear();
  (messagingInstance.getInitialNotification as jest.Mock).mockClear();
  (notifee.getInitialNotification as jest.Mock).mockClear();
  (messagingInstance.onNotificationOpenedApp as jest.Mock).mockClear();
  (notifee.onForegroundEvent as jest.Mock).mockClear();
});

test('dispatchIdFromNotificationData reads a non-empty string dispatchId only', () => {
  expect(dispatchIdFromNotificationData({ dispatchId: 'DISP-1' })).toBe('DISP-1');
  expect(dispatchIdFromNotificationData({ dispatchId: '' })).toBeNull();
  expect(dispatchIdFromNotificationData({})).toBeNull();
  expect(dispatchIdFromNotificationData(undefined)).toBeNull();
});

test('a cold-start open on Android navigates from the notifee-delivered initial notification', async () => {
  Platform.OS = 'android';
  (notifee.getInitialNotification as jest.Mock).mockResolvedValueOnce({
    notification: { data: { dispatchId: 'DISP-2' } },
  });

  subscribePushNotificationRouting();
  await Promise.resolve();
  await Promise.resolve();

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-2');
});

test('a cold-start open on iOS navigates from the FCM-delivered initial notification', async () => {
  Platform.OS = 'ios';
  (messagingInstance.getInitialNotification as jest.Mock).mockResolvedValueOnce({
    data: { dispatchId: 'DISP-3' },
  });

  subscribePushNotificationRouting();
  await Promise.resolve();
  await Promise.resolve();

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-3');
});

test('a background-to-foreground open navigates via onNotificationOpenedApp', () => {
  let openedCallback: ((message: unknown) => void) | undefined;
  (messagingInstance.onNotificationOpenedApp as jest.Mock).mockImplementationOnce((cb) => {
    openedCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  openedCallback?.({ data: { dispatchId: 'DISP-4' } });

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-4');
});

test('a foreground press on the Android critical notification navigates immediately', () => {
  let foregroundCallback: ((event: unknown) => void) | undefined;
  (notifee.onForegroundEvent as jest.Mock).mockImplementationOnce((cb) => {
    foregroundCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  foregroundCallback?.({
    type: EventType.PRESS,
    detail: { notification: { data: { dispatchId: 'DISP-5' } } },
  });

  expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-5');
});

test('a non-press foreground event (e.g. dismissed) does not navigate', () => {
  let foregroundCallback: ((event: unknown) => void) | undefined;
  (notifee.onForegroundEvent as jest.Mock).mockImplementationOnce((cb) => {
    foregroundCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  foregroundCallback?.({
    type: EventType.DISMISSED,
    detail: { notification: { data: { dispatchId: 'DISP-6' } } },
  });

  expect(navigateToAlertDetail).not.toHaveBeenCalled();
});
