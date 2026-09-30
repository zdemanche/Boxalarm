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
  const payload = { dispatchId: 'D1', incidentType: 'MVA', address: '1 Main St', receivedAt: 1 };

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
