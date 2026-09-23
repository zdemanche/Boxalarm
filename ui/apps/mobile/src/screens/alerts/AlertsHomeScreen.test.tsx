import { act, fireEvent, render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { AlertsHomeScreen } from './AlertsHomeScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('shows an explanation and a way to send a test alert', async () => {
  const { findByText, findByRole } = await render(<AlertsHomeScreen />);

  expect(await findByText(/confirm your phone will page correctly/i)).toBeTruthy();
  expect(await findByRole('button', { name: 'Send test alert' })).toBeTruthy();
});

test('sending a test alert navigates to that dispatch once delivered', async () => {
  const { findByRole } = await render(<AlertsHomeScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Send test alert' }));
  });

  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  expect(mockNavigate).toHaveBeenCalledWith('AlertDetail', {
    dispatchId: expect.stringMatching(/^SELFTEST-/) as unknown as string,
  });
  expect(dispatchId).toBeTruthy();
});
