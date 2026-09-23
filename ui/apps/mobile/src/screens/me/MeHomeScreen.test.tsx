import { fireEvent, render } from '@testing-library/react-native';
import { MeHomeScreen } from './MeHomeScreen';

const mockSignOut = jest.fn(async () => {});

jest.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

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
