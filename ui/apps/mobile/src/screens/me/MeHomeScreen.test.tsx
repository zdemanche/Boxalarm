import notifee from '@notifee/react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { MeHomeScreen, signOutWarning } from './MeHomeScreen';

const mockSignOut = jest.fn(async () => {});

jest.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
  useOptionalAuth: () => ({ isAuthenticated: false, memberId: null }),
}));

jest.mock('react-native-config', () => ({ __esModule: true, default: {} }));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockSignOut.mockClear();
  mockNavigate.mockClear();
});

test('shows the member profile once it loads', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(await findByText('Firefighter')).toBeTruthy();
});

test('lists held qualifications with eligibility (E2-S2)', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  expect(await findByText(/INTERIOR/)).toBeTruthy();
  expect(await findByText(/DRIVER_OPERATOR/)).toBeTruthy();
  expect(await findByText(/Not currently eligible/)).toBeTruthy();
});

test('navigating to Certifications', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText('Certifications'));
  expect(mockNavigate).toHaveBeenCalledWith('Certifications');
});

test('navigating to the self-test entry point', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText('Test my alert path'));
  expect(mockNavigate).toHaveBeenCalledWith('SelfTest');
});

test('navigating to the diagnostics entry point', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText("Why didn't I get the page?"));
  expect(mockNavigate).toHaveBeenCalledWith('Diagnostics');
});

test('sign-out asks first and warns that the phone will stop receiving pages', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText('Sign out'));

  expect(mockSignOut).not.toHaveBeenCalled();
  const [title, message, buttons] = alertSpy.mock.calls[0]!;
  expect(title).toMatch(/stop getting app pages/i);
  expect(message).toMatch(/stop on every phone or tablet you use/i);
  expect(message).toMatch(/continue only if they are set up for you/i);
  const cancel = buttons!.find((button) => button.style === 'cancel')!;
  const confirm = buttons!.find((button) => button.style === 'destructive')!;
  expect(cancel.text).toBe('Stay signed in');

  cancel.onPress?.();
  expect(mockSignOut).not.toHaveBeenCalled();
  confirm.onPress?.();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  alertSpy.mockRestore();
});

test('a phone that cannot be paged shows the red readiness banner with a fix', async () => {
  (notifee.getNotificationSettings as jest.Mock).mockResolvedValueOnce({ authorizationStatus: 0 });
  const { findByText, findByRole } = await render(<MeHomeScreen />);

  expect(await findByText(/This phone may not wake you for a page/)).toBeTruthy();
  expect(await findByRole('button', { name: 'Fix: Notifications' })).toBeTruthy();
});

test('a ready phone shows no readiness banner', async () => {
  const { findByText, queryByText } = await render(<MeHomeScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(queryByText(/This phone may not wake you for a page/)).toBeNull();
});

test('without a phone number on file, sign-out does not promise text or voice pages', () => {
  expect(signOutWarning('')).toMatch(/no phone number is on file/i);
  expect(signOutWarning('203-555-0100')).toMatch(/to 203-555-0100 continue only if/);
});
