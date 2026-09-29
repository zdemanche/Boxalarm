import { NativeModules, Platform } from 'react-native';
import { navigateToAlertDetail, navigationRef } from '../../navigation/navigationRef';
import {
  markInitialAlertRoutingSettled,
  resetLockScreenPresentationForTest,
  syncLockScreenPresentation,
} from './lockScreenPresentation';

const nativeModules = NativeModules as { BoxalarmAlertReadiness?: unknown };
let setShowWhenLocked: jest.Mock;
let focused: string;
let ready: boolean;

beforeEach(() => {
  Platform.OS = 'android';
  resetLockScreenPresentationForTest();
  setShowWhenLocked = jest.fn();
  nativeModules.BoxalarmAlertReadiness = { setShowWhenLocked };
  focused = 'AlertsHome';
  ready = true;
  jest.spyOn(navigationRef, 'isReady').mockImplementation(() => ready);
  jest
    .spyOn(navigationRef, 'getCurrentRoute')
    .mockImplementation(() => ({ key: focused, name: focused }) as never);
  jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});
});

afterEach(() => {
  delete nativeModules.BoxalarmAlertReadiness;
  jest.restoreAllMocks();
});

test('second page while locked: moving from call A to call B never clears show-over-lock-screen', () => {
  focused = 'AlertDetail'; // call A left open
  markInitialAlertRoutingSettled();
  syncLockScreenPresentation();
  // Native onNewIntent (keyguard locked) has set the flag; JS routes to call B.
  navigateToAlertDetail('B');
  focused = 'AlertDetail'; // call B pushed on top
  syncLockScreenPresentation();

  expect(setShowWhenLocked).not.toHaveBeenCalledWith(false);
});

test('leaving every alert (another tab, back to the list) clears it', () => {
  markInitialAlertRoutingSettled();
  focused = 'AlertDetail';
  syncLockScreenPresentation();
  focused = 'MeHome';
  syncLockScreenPresentation();

  expect(setShowWhenLocked).toHaveBeenLastCalledWith(false);
});

test('a cold start from a full-screen page is not hidden before its initial notification is routed', () => {
  focused = 'AlertsHome';
  syncLockScreenPresentation(); // onReady, before the launch notification resolved
  expect(setShowWhenLocked).not.toHaveBeenCalled();

  focused = 'AlertDetail';
  markInitialAlertRoutingSettled();
  expect(setShowWhenLocked).not.toHaveBeenCalled();
});

test('when the launch was not an alert (routing failed, signed out), the app does not stay over the keyguard', () => {
  focused = 'SignIn';
  markInitialAlertRoutingSettled();

  expect(setShowWhenLocked).toHaveBeenCalledWith(false);
});

test('an alert still waiting for the navigator holds the flag', () => {
  ready = false;
  navigateToAlertDetail('PENDING'); // held until ready
  ready = true;
  markInitialAlertRoutingSettled();

  expect(setShowWhenLocked).not.toHaveBeenCalled();
});
