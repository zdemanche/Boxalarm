import { Alert, AppState, Platform, Settings } from 'react-native';
import * as auth from '../../auth/AuthContext';
import notifee, { EventType } from '@notifee/react-native';
import * as messaging from '@react-native-firebase/messaging';
import { navigateToAlertDetail, navigateToMutualAidPrompt } from '../../navigation/navigationRef';
import {
  dispatchIdFromNotificationData,
  resetRoutedRingingPagesForTest,
  routeToRingingPage,
  subscribePushNotificationRouting,
} from './pushRouting';

const getInitialNotification = messaging.getInitialNotification as jest.Mock;
const onNotificationOpenedApp = messaging.onNotificationOpenedApp as jest.Mock;

let mockNavigationReady = true;
let mockAppTabs = true;
let mockNavigationListener: (() => void) | undefined;
jest.mock('../../navigation/navigationRef', () => ({
  navigateToAlertDetail: jest.fn(),
  navigateToMutualAidPrompt: jest.fn(),
  isNavigationReady: jest.fn(() => mockNavigationReady),
  isAlertRouteAvailable: jest.fn(() => mockNavigationReady && mockAppTabs),
  hasPendingAlertNavigation: jest.fn(() => false),
  navigationRef: { isReady: () => false, getCurrentRoute: () => undefined },
  onNavigationStateChange: jest.fn((listener: () => void) => {
    mockNavigationListener = listener;
    return () => {};
  }),
}));

// NSUserDefaults via the Settings stand-in from jest.setup.js, which keeps React Native's
// native store and JS-side copy apart. AppDelegate's tap record is a native write
// (`nativeWrite`), visible to JS only at cold start (`coldStart`, the constants snapshot) or
// through the settingsUpdated event (`settingsWatcher`).
const settingsStub = Settings as typeof Settings & {
  __reset: () => void;
  __nativeWrite: (values: Record<string, unknown>) => void;
  __coldStart: () => void;
  __emitChange: () => void;
};
const nativeWrite = (values: Record<string, unknown>) => settingsStub.__nativeWrite(values);
const coldStart = () => settingsStub.__coldStart();
const settingsWatcher = () => settingsStub.__emitChange();
let appStateListener: ((status: string) => void) | undefined;

beforeEach(() => {
  settingsStub.__reset();
  (Settings.get as jest.Mock).mockClear();
  mockNavigationReady = true;
  mockAppTabs = true;
  mockNavigationListener = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (status: string) => void;
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  (navigateToAlertDetail as jest.Mock).mockClear();
  getInitialNotification.mockClear();
  (notifee.getInitialNotification as jest.Mock).mockClear();
  onNotificationOpenedApp.mockClear();
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

  expect(navigateToAlertDetail).toHaveBeenCalledWith(
    'DISP-2',
    expect.objectContaining({ dispatchId: 'DISP-2' }),
  );
});

test('a cold-start open on iOS navigates from the FCM-delivered initial notification', async () => {
  Platform.OS = 'ios';
  getInitialNotification.mockResolvedValueOnce({
    data: { dispatchId: 'DISP-3' },
  });

  subscribePushNotificationRouting();
  await Promise.resolve();
  await Promise.resolve();

  expect(navigateToAlertDetail).toHaveBeenCalledWith(
    'DISP-3',
    expect.objectContaining({ dispatchId: 'DISP-3' }),
  );
});

test('a background-to-foreground open navigates via onNotificationOpenedApp', () => {
  let openedCallback: ((message: unknown) => void) | undefined;
  onNotificationOpenedApp.mockImplementationOnce((_instance: unknown, cb: (m: unknown) => void) => {
    openedCallback = cb;
    return () => {};
  });

  subscribePushNotificationRouting();
  openedCallback?.({ data: { dispatchId: 'DISP-4' } });

  expect(navigateToAlertDetail).toHaveBeenCalledWith(
    'DISP-4',
    expect.objectContaining({ dispatchId: 'DISP-4' }),
  );
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

  expect(navigateToAlertDetail).toHaveBeenCalledWith(
    'DISP-5',
    expect.objectContaining({ dispatchId: 'DISP-5' }),
  );
});

test("an officer's mutual-aid prompt opens the prompt screen, not the call's alert screen", () => {
  let foregroundCallback: ((event: unknown) => void) | undefined;
  (notifee.onForegroundEvent as jest.Mock).mockImplementationOnce((cb) => {
    foregroundCallback = cb;
    return () => {};
  });
  (navigateToMutualAidPrompt as jest.Mock).mockClear();

  subscribePushNotificationRouting();
  foregroundCallback?.({
    type: EventType.PRESS,
    detail: {
      notification: { data: { dispatchId: 'DISP-MA', alertKind: 'mutual_aid_prompt' } },
    },
  });

  expect(navigateToMutualAidPrompt).toHaveBeenCalledWith(
    'DISP-MA',
    expect.objectContaining({ dispatchId: 'DISP-MA', mutualAidPrompt: true }),
  );
  expect(navigateToAlertDetail).not.toHaveBeenCalled();
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

describe('iOS taps on raw-APNs dispatch notifications (review round 2 N3)', () => {
  const nowSeconds = () => Date.now() / 1000;
  const tap = (dispatchId: string, tappedAt = nowSeconds()) => ({
    'boxalarm.pendingAlertTap': { dispatchId, tappedAt },
  });

  beforeEach(() => {
    Platform.OS = 'ios';
  });

  test('cold start: a tap recorded before JS loaded routes once the navigator mounts, then is cleared', () => {
    nativeWrite(tap('DISP-COLD'));
    coldStart();
    mockNavigationReady = false;

    subscribePushNotificationRouting();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    mockNavigationReady = true;
    mockNavigationListener?.();

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-COLD',
      expect.objectContaining({ dispatchId: 'DISP-COLD' }),
    );
    expect(Settings.get('boxalarm.pendingAlertTap')).toBeNull();
  });

  test('background/foreground: a native tap record reaches JS only through the settings change event', () => {
    subscribePushNotificationRouting();
    nativeWrite(tap('DISP-WARM'));
    // Not visible to Settings.get yet - React Native only learns of it from settingsUpdated.
    appStateListener?.('active');
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    settingsWatcher();

    expect(navigateToAlertDetail).toHaveBeenCalledTimes(1);
    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-WARM',
      expect.objectContaining({ dispatchId: 'DISP-WARM' }),
    );
    // Clearing the record does not echo (RCTSettingsManager ignores its own writes), and a later
    // unrelated settings change must not navigate again.
    settingsWatcher();
    expect(navigateToAlertDetail).toHaveBeenCalledTimes(1);
  });

  test('resume retries a tap that reached JS while navigation could not take it', () => {
    mockNavigationReady = false;
    subscribePushNotificationRouting();
    nativeWrite(tap('DISP-RESUME'));
    settingsWatcher();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();

    mockNavigationReady = true;
    appStateListener?.('active');

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-RESUME',
      expect.objectContaining({ dispatchId: 'DISP-RESUME' }),
    );
  });

  test('a stale tap (older than 10 minutes) is discarded without navigating', () => {
    nativeWrite(tap('DISP-OLD', nowSeconds() - 601));
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).not.toHaveBeenCalled();
    expect(Settings.get('boxalarm.pendingAlertTap')).toBeNull();
  });

  test('the page text AppDelegate records rides along, so the alert screen paints the address', () => {
    nativeWrite({
      'boxalarm.pendingAlertTap': {
        dispatchId: 'DISP-TEXT',
        tappedAt: nowSeconds(),
        title: 'Structure fire',
        body: 'Structure fire — 21 Main St',
        toneSequence: '2',
      },
    });
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-TEXT',
      expect.objectContaining({
        incidentType: 'Structure fire',
        address: '21 Main St',
        toneSequence: 2,
      }),
    );
  });

  test('a Responding action pressed on the page is queued once, then the call opens', async () => {
    const store = jest.requireActual(
      '../../sync/outboxStore',
    ) as typeof import('../../sync/outboxStore');
    nativeWrite({
      'boxalarm.pendingAlertTap': {
        dispatchId: 'DISP-ACTION',
        tappedAt: nowSeconds(),
        title: 'MVA',
        body: 'MVA — 1 Main St',
        action: 'respond:RESPONDING',
      },
    });
    coldStart();
    mockNavigationReady = false;

    subscribePushNotificationRouting();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Queued before navigation is ready - the answer does not wait on the UI.
    const rows = (await store.all()).filter((row) => row.path.includes('DISP-ACTION'));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.body)).toMatchObject({ ackStatus: 'RESPONDING' });

    mockNavigationReady = true;
    mockNavigationListener?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-ACTION',
      expect.objectContaining({ address: '1 Main St' }),
    );
    expect((await store.all()).filter((row) => row.path.includes('DISP-ACTION'))).toHaveLength(1);
  });

  test('M2: an action pressed on a signed-out phone is not queued; the member is told and the call opens after sign-in', async () => {
    const store = jest.requireActual(
      '../../sync/outboxStore',
    ) as typeof import('../../sync/outboxStore');
    jest.spyOn(auth, 'readStoredSessionOwner').mockResolvedValue(null);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    nativeWrite({
      'boxalarm.pendingAlertTap': {
        dispatchId: 'DISP-OUT',
        tappedAt: nowSeconds(),
        title: 'MVA',
        body: 'MVA — 2 Main St',
        action: 'respond:RESPONDING',
      },
    });
    coldStart();
    mockAppTabs = false; // the sign-in screens are showing

    subscribePushNotificationRouting();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await store.all()).filter((row) => row.path.includes('DISP-OUT'))).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(
      "You're signed out on this phone",
      expect.stringMatching(/sign in to answer, or use the radio/i),
    );
    expect(navigateToAlertDetail).not.toHaveBeenCalled();
    expect(Settings.get('boxalarm.pendingAlertTap')).toMatchObject({ dispatchId: 'DISP-OUT' });
    expect(Settings.get('boxalarm.pendingAlertTap')).not.toHaveProperty('action');

    mockAppTabs = true; // signed in
    mockNavigationListener?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigateToAlertDetail).toHaveBeenCalledWith('DISP-OUT', expect.anything());
    expect((await store.all()).filter((row) => row.path.includes('DISP-OUT'))).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('the page time is when iOS delivered it, not when it was tapped (review MJ-2)', () => {
    const deliveredAt = nowSeconds() - 300;
    nativeWrite({
      'boxalarm.pendingAlertTap': {
        dispatchId: 'DISP-LATE',
        tappedAt: nowSeconds(),
        deliveredAt,
        title: 'MVA',
        body: 'MVA — 1 Main St',
      },
    });
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-LATE',
      expect.objectContaining({ receivedAt: deliveredAt * 1000 }),
    );
  });

  test('explicit keys AppDelegate copies from the page win over the body, and dispatchedAt is the dispatch time (round 2 C-4)', () => {
    nativeWrite({
      'boxalarm.pendingAlertTap': {
        dispatchId: 'DISP-KEYS',
        tappedAt: nowSeconds(),
        deliveredAt: nowSeconds() - 60,
        title: 'STRUCTURE FIRE · TONE 2',
        body: 'something else entirely',
        incidentType: 'Structure fire',
        address: '21 Main St',
        crossStreets: 'Elm / Oak',
        dispatchedAt: '1700000000',
      },
    });
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'DISP-KEYS',
      expect.objectContaining({
        incidentType: 'Structure fire',
        address: '21 Main St',
        crossStreets: 'Elm / Oak',
        dispatchedAt: 1_700_000_000_000,
      }),
    );
  });

  test('a malformed record is discarded without navigating', () => {
    nativeWrite({ 'boxalarm.pendingAlertTap': { dispatchId: 7, tappedAt: nowSeconds() } });
    coldStart();

    subscribePushNotificationRouting();

    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });

  test('Android never reads the iOS tap record', () => {
    Platform.OS = 'android';
    nativeWrite(tap('DISP-IOS-ONLY'));
    coldStart();

    subscribePushNotificationRouting();

    expect(Settings.get).not.toHaveBeenCalled();
    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });
});

describe('returning to the app while a page is ringing (m2-1 / K3-5)', () => {
  const page = (dispatchId: string, date: number, channelId = 'dispatch-critical-v2-dnd') => ({
    id: `dispatch:${dispatchId}`,
    date: String(date),
    notification: {
      id: `dispatch:${dispatchId}`,
      data: { dispatchId, incidentType: 'MVA', address: `${dispatchId} Main St`, receivedAt: '1' },
      android: { channelId },
    },
  });

  beforeEach(() => {
    Platform.OS = 'android';
    resetRoutedRingingPagesForTest();
  });

  test('opens the newest ringing call, once', async () => {
    (notifee.getDisplayedNotifications as jest.Mock).mockResolvedValue([
      page('OLDER', 1_000),
      page('NEWEST', 2_000),
    ]);

    await routeToRingingPage();
    await routeToRingingPage();

    expect(navigateToAlertDetail).toHaveBeenCalledTimes(1);
    expect(navigateToAlertDetail).toHaveBeenCalledWith(
      'NEWEST',
      expect.objectContaining({ address: 'NEWEST Main St' }),
    );
  });

  test('N-m9: a ringing mutual-aid prompt is opened on its own screen', async () => {
    (navigateToMutualAidPrompt as jest.Mock).mockClear();
    (notifee.getDisplayedNotifications as jest.Mock).mockResolvedValue([
      {
        id: 'mutual-aid:MA-1',
        date: 5_000,
        notification: {
          id: 'mutual-aid:MA-1',
          data: { dispatchId: 'MA-1', alertKind: 'mutual_aid_prompt', receivedAt: '1' },
          android: { channelId: 'dispatch-critical-v2' },
        },
      },
    ]);

    await routeToRingingPage();

    expect(navigateToMutualAidPrompt).toHaveBeenCalledWith(
      'MA-1',
      expect.objectContaining({ mutualAidPrompt: true }),
    );
    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });

  test('an answered page (replaced on the default channel) does not pull the member back', async () => {
    (notifee.getDisplayedNotifications as jest.Mock).mockResolvedValue([
      page('ANSWERED', 3_000, 'notifications-default'),
    ]);

    await routeToRingingPage();

    expect(navigateToAlertDetail).not.toHaveBeenCalled();
  });

  test('wired to the app becoming active on Android', async () => {
    (notifee.getDisplayedNotifications as jest.Mock).mockResolvedValue([page('ACTIVE', 1)]);

    subscribePushNotificationRouting();
    appStateListener?.('active');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigateToAlertDetail).toHaveBeenCalledWith('ACTIVE', expect.anything());
  });
});
