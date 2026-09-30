import { flushPendingAlertNavigation, navigateToAlertDetail, navigationRef } from './navigationRef';

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
