import { NativeModules, Platform } from 'react-native';
import notifee from '@notifee/react-native';
import {
  categoryFromPushData,
  channelForCategory,
  CRITICAL_CHANNEL_DND_ID,
  CRITICAL_CHANNEL_ID,
  DEFAULT_CHANNEL_ID,
  ensureNotificationChannels,
  resetCriticalChannelIdForTest,
} from './pushChannel';

const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };

function installNative(dndAccessGranted: boolean, createFails = false) {
  const native = {
    getReadiness: jest.fn(async () => ({
      dndAccessGranted,
      fullScreenIntentAllowed: true,
      sdkInt: 35,
    })),
    createCriticalChannel: jest.fn(async () => {
      if (createFails) throw new Error('boom');
      return dndAccessGranted;
    }),
    deleteChannel: jest.fn(async () => undefined),
  };
  nativeModules.BoxalarmAlertReadiness = native;
  return native;
}

afterEach(() => {
  resetCriticalChannelIdForTest();
  delete nativeModules.BoxalarmAlertReadiness;
  jest.restoreAllMocks();
});

test('a dispatch push (no category, or category dispatch) selects the critical channel', async () => {
  Platform.OS = 'android';
  expect(categoryFromPushData(undefined)).toBe('dispatch');
  expect(categoryFromPushData({ category: 'dispatch' })).toBe('dispatch');
  await expect(channelForCategory(categoryFromPushData(undefined))).resolves.toBe(
    CRITICAL_CHANNEL_ID,
  );
});

test('a digest push selects the non-critical channel', async () => {
  expect(categoryFromPushData({ category: 'digest' })).toBe('digest');
  await expect(channelForCategory('digest')).resolves.toBe(DEFAULT_CHANNEL_ID);
});

test('without the native module, notifee creates the versioned critical (DND-bypass) and default channels', async () => {
  Platform.OS = 'android';
  const createChannel = notifee.createChannel as jest.Mock;
  createChannel.mockClear();

  await expect(ensureNotificationChannels()).resolves.toBe(CRITICAL_CHANNEL_ID);

  expect(createChannel).toHaveBeenCalledWith(
    expect.objectContaining({ id: CRITICAL_CHANNEL_ID, bypassDnd: true }),
  );
  expect(createChannel).toHaveBeenCalledWith(
    expect.objectContaining({ id: DEFAULT_CHANNEL_ID, bypassDnd: false }),
  );
});

test('with DND access granted, the critical channel is recreated under the -dnd id and the others are deleted', async () => {
  Platform.OS = 'android';
  const native = installNative(true);

  await expect(ensureNotificationChannels({ deleteStale: true })).resolves.toBe(
    CRITICAL_CHANNEL_DND_ID,
  );

  expect(native.createCriticalChannel).toHaveBeenCalledWith(
    CRITICAL_CHANNEL_DND_ID,
    expect.any(String),
  );
  expect(native.deleteChannel).toHaveBeenCalledWith(CRITICAL_CHANNEL_ID);
  expect(native.deleteChannel).toHaveBeenCalledWith('dispatch-critical');
});

test('without DND access, the plain versioned channel is used and the retired one is deleted', async () => {
  Platform.OS = 'android';
  const native = installNative(false);

  await expect(ensureNotificationChannels({ deleteStale: true })).resolves.toBe(
    CRITICAL_CHANNEL_ID,
  );

  expect(native.createCriticalChannel).toHaveBeenCalledWith(
    CRITICAL_CHANNEL_ID,
    expect.any(String),
  );
  expect(native.deleteChannel).toHaveBeenCalledWith(CRITICAL_CHANNEL_DND_ID);
  expect(native.deleteChannel).toHaveBeenCalledWith('dispatch-critical');
});

test('a failing native channel create falls back to a notifee channel, so a page is never posted to a missing channel', async () => {
  Platform.OS = 'android';
  installNative(true, true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const createChannel = notifee.createChannel as jest.Mock;
  createChannel.mockClear();

  await expect(ensureNotificationChannels()).resolves.toBe(CRITICAL_CHANNEL_ID);
  expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: CRITICAL_CHANNEL_ID }));
});

test('ensureNotificationChannels is a no-op on iOS, which has no channel concept', async () => {
  Platform.OS = 'ios';
  const createChannel = notifee.createChannel as jest.Mock;
  createChannel.mockClear();

  await ensureNotificationChannels();

  expect(createChannel).not.toHaveBeenCalled();
});

test('the page path never deletes a channel (a concurrent page may be posting to it)', async () => {
  Platform.OS = 'android';
  const native = installNative(true);

  await ensureNotificationChannels();

  expect(native.createCriticalChannel).toHaveBeenCalledWith(
    CRITICAL_CHANNEL_DND_ID,
    expect.any(String),
  );
  expect(native.deleteChannel).not.toHaveBeenCalled();
});

test('a transient DND-access read error keeps the last known channel instead of flipping to -v2', async () => {
  Platform.OS = 'android';
  const native = installNative(true);
  await ensureNotificationChannels();
  native.getReadiness.mockRejectedValueOnce(new Error('transient'));

  await expect(ensureNotificationChannels()).resolves.toBe(CRITICAL_CHANNEL_DND_ID);
});
