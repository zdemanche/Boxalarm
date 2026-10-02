import { flushPendingAlertNavigation, navigateToAlertDetail, navigationRef } from './navigationRef';

type RootState = ReturnType<typeof navigationRef.getRootState>;
const tabs = { routeNames: ['Alerts', 'Me'] } as unknown as RootState;
const signIn = { routeNames: ['SignIn'] } as unknown as RootState;

beforeEach(() => {
  jest.spyOn(navigationRef, 'getRootState').mockReturnValue(tabs);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('an alert opened before the navigator is ready is held and opened on ready, not dropped', () => {
  const ready = jest.spyOn(navigationRef, 'isReady').mockReturnValue(false);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});
  const payload = {
    dispatchId: 'D1',
    incidentType: 'MVA',
    address: '1 Main St',
    receivedAt: Date.now(),
  };

  navigateToAlertDetail('D1', payload);
  expect(navigate).not.toHaveBeenCalled();

  ready.mockReturnValue(true);
  flushPendingAlertNavigation();

  expect(navigate).toHaveBeenCalledWith('Alerts', {
    screen: 'AlertDetail',
    params: { dispatchId: 'D1', payload },
  });

  navigate.mockClear();
  flushPendingAlertNavigation();
  expect(navigate).not.toHaveBeenCalled();
});

test('a ready navigator opens the alert immediately', () => {
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});

  navigateToAlertDetail('D2');

  expect(navigate).toHaveBeenCalledWith('Alerts', {
    screen: 'AlertDetail',
    params: { dispatchId: 'D2' },
  });
});

test('an alert opened while the sign-in screens show is held until the tabs mount (M2)', () => {
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const root = jest.spyOn(navigationRef, 'getRootState').mockReturnValue(signIn);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});

  navigateToAlertDetail('D3');
  flushPendingAlertNavigation();
  expect(navigate).not.toHaveBeenCalled();

  root.mockReturnValue(tabs);
  flushPendingAlertNavigation();
  expect(navigate).toHaveBeenCalledWith('Alerts', {
    screen: 'AlertDetail',
    params: { dispatchId: 'D3' },
  });
});

test('a page held while signed out is dropped once its call is past the 2 h window (N-m6)', () => {
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const root = jest.spyOn(navigationRef, 'getRootState').mockReturnValue(signIn);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});
  const old = {
    dispatchId: 'D-OLD',
    incidentType: 'MVA',
    address: '1 Main St',
    receivedAt: Date.now() - 2 * 60 * 60_000 - 1,
  };

  navigateToAlertDetail('D-OLD', old);
  root.mockReturnValue(tabs);
  flushPendingAlertNavigation();

  expect(navigate).not.toHaveBeenCalled();
});

test('an inbox tap before the navigator is ready is held and opened on flush, once', () => {
  const { navigateToInbox } = jest.requireActual<typeof import('./navigationRef')>(
    './navigationRef',
  );
  const ready = jest.spyOn(navigationRef, 'isReady').mockReturnValue(false);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});

  navigateToInbox();
  expect(navigate).not.toHaveBeenCalled();

  ready.mockReturnValue(true);
  flushPendingAlertNavigation();
  expect(navigate).toHaveBeenCalledWith('Me', { screen: 'Inbox' });

  navigate.mockClear();
  flushPendingAlertNavigation();
  expect(navigate).not.toHaveBeenCalled();
});

test('a ready navigator opens the inbox immediately on Me > Inbox', () => {
  const { navigateToInbox } = jest.requireActual<typeof import('./navigationRef')>(
    './navigationRef',
  );
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});

  navigateToInbox();

  expect(navigate).toHaveBeenCalledWith('Me', { screen: 'Inbox' });
});

test('an inbox tap while the sign-in screens show is held until the tabs mount', () => {
  const { navigateToInbox } = jest.requireActual<typeof import('./navigationRef')>(
    './navigationRef',
  );
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const root = jest.spyOn(navigationRef, 'getRootState').mockReturnValue(signIn);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => {});

  navigateToInbox();
  flushPendingAlertNavigation();
  expect(navigate).not.toHaveBeenCalled();

  root.mockReturnValue(tabs);
  flushPendingAlertNavigation();
  expect(navigate).toHaveBeenCalledWith('Me', { screen: 'Inbox' });
});
