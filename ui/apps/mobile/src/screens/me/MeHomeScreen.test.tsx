import notifee from '@notifee/react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { MeHomeScreen } from './MeHomeScreen';

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

test('signing out calls the real signOut from AuthContext', async () => {
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText('Sign out'));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
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
