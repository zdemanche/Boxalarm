import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import { CRITICAL_CHANNEL_ID, DEFAULT_CHANNEL_ID } from './pushChannel';
import { displayPushNotification } from './pushNotificationDisplay';

const displayNotification = notifee.displayNotification as jest.Mock;

beforeEach(() => {
  displayNotification.mockClear();
});

test('a dispatch push displays on the critical channel with a full-screen action', async () => {
  Platform.OS = 'android';

  await displayPushNotification({ dispatchId: 'DISP-1', title: 'Structure fire' });

  const call = displayNotification.mock.calls[0][0];
  expect(call.android.channelId).toBe(CRITICAL_CHANNEL_ID);
  expect(call.android.fullScreenAction).toBeDefined();
  expect(call.data).toEqual({ dispatchId: 'DISP-1', category: 'dispatch' });
});

test('a digest push displays on the default channel without a full-screen action', async () => {
  Platform.OS = 'android';

  await displayPushNotification({ category: 'digest', title: 'Cert expiring' });

  const call = displayNotification.mock.calls[0][0];
  expect(call.android.channelId).toBe(DEFAULT_CHANNEL_ID);
  expect(call.android.fullScreenAction).toBeUndefined();
});

test('does nothing on iOS, where the OS displays the push natively', async () => {
  Platform.OS = 'ios';

  await displayPushNotification({ dispatchId: 'DISP-1' });

  expect(displayNotification).not.toHaveBeenCalled();
});
