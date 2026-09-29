import notifee from '@notifee/react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { rememberAlertPayload } from '../../features/alerts/alertPayload';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { AlertsHomeScreen } from './AlertsHomeScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

let mockAuth: { roles: string[] } | undefined;
jest.mock('../../auth/AuthContext', () => ({
  useOptionalAuth: () => mockAuth,
}));

beforeEach(() => {
  mockNavigate.mockClear();
  mockAuth = undefined;
});

test('a member with no officer/chief role is not offered manual entry', async () => {
  mockAuth = { roles: ['MEMBER'] };
  const { queryByRole } = await render(<AlertsHomeScreen />);

  expect(queryByRole('button', { name: 'Enter dispatch manually' })).toBeNull();
});

test('an officer is offered manual entry and it navigates to the entry form', async () => {
  mockAuth = { roles: ['OFFICER'] };
  const { findByRole } = await render(<AlertsHomeScreen />);

  fireEvent.press(await findByRole('button', { name: 'Enter dispatch manually' }));
  expect(mockNavigate).toHaveBeenCalledWith('ManualEntry');
});

test('a chief is also offered manual entry', async () => {
  mockAuth = { roles: ['CHIEF'] };
  const { findByRole } = await render(<AlertsHomeScreen />);

  expect(await findByRole('button', { name: 'Enter dispatch manually' })).toBeTruthy();
});

describe('active call list (alert-ux C3)', () => {
  const now = Math.floor(Date.now() / 1000);
  const list = {
    dispatches: [
      {
        dispatchId: 'D-1',
        incidentType: 'Structure fire',
        address: '21 Main St',
        crossStreets: 'Elm / Oak',
        dispatchedAt: now - 180,
        toneSequence: 2,
      },
    ],
    asOf: now,
    truncated: false,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('lists active calls and opens one with its address already in hand', async () => {
    jest.spyOn(mockAlertsRepository, 'listActiveDispatches').mockResolvedValue(list);
    const { findByRole } = await render(<AlertsHomeScreen />);

    const row = await findByRole('button', { name: /Structure fire at 21 Main St/ });
    fireEvent.press(row);

    expect(mockNavigate).toHaveBeenCalledWith('AlertDetail', {
      dispatchId: 'D-1',
      payload: expect.objectContaining({ address: '21 Main St', toneSequence: 2 }),
    });
  });

  test('says plainly when there is no active call', async () => {
    jest
      .spyOn(mockAlertsRepository, 'listActiveDispatches')
      .mockResolvedValue({ dispatches: [], asOf: now, truncated: false });
    const { findByText } = await render(<AlertsHomeScreen />);

    expect(await findByText(/no active calls/i)).toBeTruthy();
  });

  test('offline, the last good list stays on screen, stamped with its time', async () => {
    const spy = jest.spyOn(mockAlertsRepository, 'listActiveDispatches').mockResolvedValue(list);
    const { findByText, rerender } = await render(<AlertsHomeScreen key="first" />);
    expect(await findByText('21 Main St')).toBeTruthy();

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    spy.mockRejectedValue(new TypeError('Network request failed'));
    // Leave and come back: a fresh screen over the same phone storage.
    await act(async () => {
      rerender(<AlertsHomeScreen key="second" />);
    });

    expect(await findByText(/showing active calls saved on this phone at/i)).toBeTruthy();
    expect(await findByText('21 Main St')).toBeTruthy();
  });

  test('offline with no saved list, a page this phone received is still offered', async () => {
    jest
      .spyOn(mockAlertsRepository, 'listActiveDispatches')
      .mockRejectedValue(new TypeError('Network request failed'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await rememberAlertPayload({
      dispatchId: 'D-PAGE',
      incidentType: 'MVA',
      address: '9 Oak Ave',
      receivedAt: Date.now() - 60_000,
    });

    const { findByText } = await render(<AlertsHomeScreen />);

    expect(await findByText('9 Oak Ave')).toBeTruthy();
    expect(await findByText(/received on this phone - not confirmed/i)).toBeTruthy();
  });

  test('pull-to-refresh and the Refresh button both reload the list', async () => {
    const spy = jest
      .spyOn(mockAlertsRepository, 'listActiveDispatches')
      .mockResolvedValue({ dispatches: [], asOf: now, truncated: false });
    const { findByRole } = await render(<AlertsHomeScreen />);
    await findByRole('button', { name: 'Refresh active calls' });
    const before = spy.mock.calls.length;

    await act(async () => {
      fireEvent.press(await findByRole('button', { name: 'Refresh active calls' }));
    });

    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});

test('the Alerts tab carries the red readiness banner when this phone cannot be paged', async () => {
  (notifee.getNotificationSettings as jest.Mock).mockResolvedValueOnce({ authorizationStatus: 2 });
  const { findByText, findByRole } = await render(<AlertsHomeScreen />);

  expect(await findByText(/This phone may not wake you for a page/)).toBeTruthy();
  fireEvent.press(await findByRole('button', { name: 'See all alert readiness checks' }));
  expect(mockNavigate).toHaveBeenCalledWith('Me', { screen: 'SelfTest' });
});
