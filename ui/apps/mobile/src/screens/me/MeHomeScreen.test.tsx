import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as syncManager from '../../sync/syncManager';
import { Alert } from 'react-native';
import { MeHomeScreen, signOutWarning } from './MeHomeScreen';

const mockSignOut = jest.fn(async () => {});

jest.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ signOut: mockSignOut, memberId: 'm-a' }),
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
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());

  expect(mockSignOut).not.toHaveBeenCalled();
  const [title, message, buttons] = alertSpy.mock.calls[0]!;
  expect(title).toBe('Sign out and stop getting pages on this phone?');
  expect(message).toMatch(
    /^Boxalarm pages stop on this phone until you sign in again; your other signed-in devices keep getting pages\./,
  );
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

test('without a phone number on file, sign-out does not promise text or voice pages', () => {
  expect(signOutWarning('')).toMatch(/no phone number is on file/i);
  expect(signOutWarning('203-555-0100')).toMatch(/to 203-555-0100 continue only if/);
});

test('the Sign out button names the consequence for this phone', async () => {
  const { findByRole } = await render(<MeHomeScreen />);

  expect(
    await findByRole('button', { name: 'Sign out. Boxalarm pages stop on this phone.' }),
  ).toBeTruthy();
});

test('Mark unavailable is the first action on Me and opens the availability screen', async () => {
  const { findByRole } = await render(<MeHomeScreen />);

  fireEvent.press(
    await findByRole('button', {
      name: "Mark unavailable. Choose how long you won't be alerted.",
    }),
  );
  expect(mockNavigate).toHaveBeenCalledWith('Availability');
});

// R2-M3: queued work stays the member's; signing out says so and offers to discard it.
test("sign-out with unsent items says they'll send next sign-in, and offers to discard them", async () => {
  const countSpy = jest.spyOn(syncManager, 'countUnsentFor').mockResolvedValue(2);
  const discardSpy = jest.spyOn(syncManager, 'discardAllFor').mockResolvedValue();
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { findByText } = await render(<MeHomeScreen />);

  fireEvent.press(await findByText('Sign out'));
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());

  const [, message, buttons] = alertSpy.mock.calls[0]!;
  expect(countSpy).toHaveBeenCalledWith('m-a');
  expect(message).toMatch(/2 items haven't been sent yet\. They'll send next time you sign in/);
  const discard = buttons!.find((button) => button.text === 'Discard 2 unsent and sign out')!;
  discard.onPress?.();
  await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  expect(discardSpy).toHaveBeenCalledWith('m-a');
  countSpy.mockRestore();
  discardSpy.mockRestore();
  alertSpy.mockRestore();
});
