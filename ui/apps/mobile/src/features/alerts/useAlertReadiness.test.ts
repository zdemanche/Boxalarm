import notifee from '@notifee/react-native';
import { NativeModules, Platform } from 'react-native';
import { blockingReadinessItems, evaluateAlertReadiness } from './useAlertReadiness';

const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };
const getNotificationSettings = notifee.getNotificationSettings as jest.Mock;

function installNative(readiness: {
  dndAccessGranted: boolean;
  fullScreenIntentAllowed: boolean;
  sdkInt: number;
}) {
  nativeModules.BoxalarmAlertReadiness = { getReadiness: jest.fn(async () => readiness) };
}

afterEach(() => {
  delete nativeModules.BoxalarmAlertReadiness;
  getNotificationSettings.mockReset().mockResolvedValue({ authorizationStatus: 1 });
});

test('denied notifications block the page', async () => {
  Platform.OS = 'ios';
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking.map((item) => item.id)).toEqual(['notifications']);
  expect(blocking[0]!.detail).toMatch(/will not show or sound/i);
});

test('provisional (quiet) authorization counts as not ready', async () => {
  Platform.OS = 'ios';
  getNotificationSettings.mockResolvedValue({ authorizationStatus: 2 });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking[0]).toMatchObject({ id: 'notifications', status: 'fail' });
  expect(blocking[0]!.detail).toMatch(/quietly/i);
});

test('Android without Do Not Disturb access or full-screen permission (Android 14+) is not ready', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: false, fullScreenIntentAllowed: false, sdkInt: 34 });

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking.map((item) => item.id)).toEqual(['dnd', 'fullScreen']);
});

test('before Android 14 the full-screen check is not asked (it is granted at install)', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 33 });

  const items = await evaluateAlertReadiness();

  expect(items.map((item) => item.id)).not.toContain('fullScreen');
  expect(blockingReadinessItems(items)).toEqual([]);
});

test('an unreadable Android state is "unknown", never "ok"', async () => {
  Platform.OS = 'android';

  const items = await evaluateAlertReadiness();

  expect(items.find((item) => item.id === 'dnd')?.status).toBe('unknown');
});

test('a blocked dispatch channel counts as notifications off', async () => {
  Platform.OS = 'android';
  installNative({ dndAccessGranted: true, fullScreenIntentAllowed: true, sdkInt: 35 });
  (notifee.isChannelBlocked as jest.Mock).mockResolvedValueOnce(true);

  const blocking = blockingReadinessItems(await evaluateAlertReadiness());

  expect(blocking[0]).toMatchObject({ id: 'notifications', status: 'fail' });
  expect(blocking[0]!.detail).toMatch(/turned off for Boxalarm/);
});
