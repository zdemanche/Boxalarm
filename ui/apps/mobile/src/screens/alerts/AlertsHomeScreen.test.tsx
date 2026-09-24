import { fireEvent, render } from '@testing-library/react-native';
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
