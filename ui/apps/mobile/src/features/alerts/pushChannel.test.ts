import { Platform } from 'react-native';
import notifee from '@notifee/react-native';
import {
  categoryFromPushData,
  channelForCategory,
  CRITICAL_CHANNEL_ID,
  DEFAULT_CHANNEL_ID,
  ensureNotificationChannels,
} from './pushChannel';

test('a dispatch push (no category, or category dispatch) selects the critical channel', () => {
  expect(categoryFromPushData(undefined)).toBe('dispatch');
  expect(categoryFromPushData({ category: 'dispatch' })).toBe('dispatch');
  expect(channelForCategory(categoryFromPushData(undefined))).toBe(CRITICAL_CHANNEL_ID);
});

test('a digest push selects the non-critical channel', () => {
  expect(categoryFromPushData({ category: 'digest' })).toBe('digest');
  expect(channelForCategory('digest')).toBe(DEFAULT_CHANNEL_ID);
});

test('ensureNotificationChannels creates the critical (DND-bypass) and default channels on Android', async () => {
  Platform.OS = 'android';
  const createChannel = notifee.createChannel as jest.Mock;
  createChannel.mockClear();

  await ensureNotificationChannels();

  expect(createChannel).toHaveBeenCalledWith(
    expect.objectContaining({ id: CRITICAL_CHANNEL_ID, bypassDnd: true }),
  );
  expect(createChannel).toHaveBeenCalledWith(
    expect.objectContaining({ id: DEFAULT_CHANNEL_ID, bypassDnd: false }),
  );
});

test('ensureNotificationChannels is a no-op on iOS, which has no channel concept', async () => {
  Platform.OS = 'ios';
  const createChannel = notifee.createChannel as jest.Mock;
  createChannel.mockClear();

  await ensureNotificationChannels();

  expect(createChannel).not.toHaveBeenCalled();
});
