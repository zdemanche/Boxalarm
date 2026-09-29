import notifee from '@notifee/react-native';
import { NativeModules, Platform } from 'react-native';
import { blockingReadinessItems, evaluateAlertReadiness } from './useAlertReadiness';

const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };
const getNotificationSettings = notifee.getNotificationSettings as jest.Mock;
const getChannel = notifee.getChannel as jest.Mock;
const isChannelBlocked = notifee.isChannelBlocked as jest.Mock;

function installNative(
  readiness: { dndAccessGranted: boolean; fullScreenIntentAllowed: boolean; sdkInt: number },
  bypass: boolean | Error = true,
) {
  nativeModules.BoxalarmAlertReadiness = {
    getReadiness: jest.fn(async () => readiness),
    getChannelBypassDnd: jest.fn(async () => {
      if (bypass instanceof Error) throw bypass;
      return bypass;
    }),
  };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

afterEach(() => {
  delete nativeModules.BoxalarmAlertReadiness;
  getNotificationSettings.mockReset().mockResolvedValue({ authorizationStatus: 1 });
  jest.restoreAllMocks();
});

test('denied notifications block the page', async () => {
  Platform.OS = 'ios';
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(ids(blocking)).toEqual(['notifications']);
  expect(blocking[0]!.detail).toMatch(/will not show or sound/i);
});

test('provisional (quiet) authorization counts as not ready', async () => {
  Platform.OS = 'ios';
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking[0]).toMatchObject({ id: 'notifications', status: 'fail' });
  expect(blocking[0]!.detail).toMatch(/quietly/i);
});

test('iOS with Sounds turned off for Boxalarm is not ready', async () => {
  Platform.OS = 'ios';
  getNotificationSettings.mockResolvedValue({
    authorizationStatus: 1,
    ios: { sound: 0, alert: 1, criticalAlert: -1 },
  });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking[0]).toMatchObject({ id: 'notifications', status: 'fail' });
  expect(blocking[0]!.detail).toMatch(/sounds are off/i);
});

test('Android without Do Not Disturb access or full-screen permission (Android 14+) is not ready', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: false, fullScreenIntentAllowed: false, sdkInt: 34 });

  expect(ids(blockingReadinessItems(await evaluateAlertReadiness()))).toEqual([
    'dnd',
    'fullScreen',
  ]);
});

test('DND access granted but the live channel does not bypass DND is not ready', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 35 }, false);

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(ids(blocking)).toEqual(['dnd']);
  expect(blocking[0]!.detail).toMatch(/Override Do Not Disturb/);
});

test('a dispatch channel set to silent, or lowered below high importance, is not ready', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 35 });

  getChannel.mockResolvedValueOnce({ id: 'x', importance: 4, blocked: false });
  expect(ids(blockingReadinessItems(await evaluateAlertReadiness()))).toEqual(['channel']);

  getChannel.mockResolvedValueOnce({
    id: 'x',
    importance: 3,
    soundURI: 'content://a',
    blocked: false,
  });
  const lowered = blockingReadinessItems(await evaluateAlertReadiness());
  expect(lowered[0]!.detail).toMatch(/lowered/);
});

test('before Android 14 the full-screen check is not asked, and a healthy phone is ready', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 33 });

  const items = await evaluateAlertReadiness();

  expect(ids(items)).not.toContain('fullScreen');
  expect(blockingReadinessItems(items)).toEqual([]);
});

test('without the native module, the wake-critical checks are unknown and raise the banner', async () => {
  Platform.OS = 'android';

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking.find((item) => item.id === 'dnd')).toMatchObject({ status: 'unknown' });
  expect(blocking.find((item) => item.id === 'dnd')!.detail).toMatch(/couldn't confirm/i);
});

test('check errors fail closed: a bypass read error or channel-blocked read error is unknown, not ready', async () => {
  Platform.OS = 'android';
  installNative(
    { dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 35 },
    new Error('boom'),
  );
  isChannelBlocked.mockRejectedValueOnce(new Error('boom'));

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking.map((item) => [item.id, item.status])).toEqual([
    ['notifications', 'unknown'],
    ['dnd', 'unknown'],
  ]);
});

test('a blocked dispatch channel counts as notifications off', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 35 });
  isChannelBlocked.mockResolvedValueOnce(true);

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking[0]).toMatchObject({ id: 'notifications', status: 'fail' });
  expect(blocking[0]!.detail).toMatch(/turned off for Boxalarm/);
});
