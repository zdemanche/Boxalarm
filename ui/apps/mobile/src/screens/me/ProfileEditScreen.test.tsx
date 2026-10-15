import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ApiError } from '../../lib/apiClient';
import { useMeRepository } from '../../features/me/apiMeRepository';
import { ProfileEditScreen } from './ProfileEditScreen';

jest.mock('../../features/me/apiMeRepository', () => ({ useMeRepository: jest.fn() }));
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: mockGoBack }) }));

let repository: { getProfile: jest.Mock; updateProfile: jest.Mock };

beforeEach(() => {
  mockGoBack.mockClear();
  repository = {
    getProfile: jest.fn(async () => ({
      firstName: 'Jamie',
      lastName: 'Rios',
      email: 'jrios@example.org',
      phone: '203-555-0100',
    })),
    updateProfile: jest.fn(async (update: Record<string, string>) => update),
  };
  (useMeRepository as jest.Mock).mockReturnValue(repository);
});

// The server refuses a member changing their own email (403): only a chief or admin can.
test('email is shown read-only with who can change it, and a save never sends it', async () => {
  await render(<ProfileEditScreen />);

  expect(await screen.findByText('jrios@example.org')).toBeTruthy();
  expect(screen.getByText('To change your email, ask a chief or admin.')).toBeTruthy();
  expect(screen.queryByDisplayValue('jrios@example.org')).toBeNull();

  await fireEvent.changeText(screen.getByLabelText('Phone'), '203-555-0199');
  await fireEvent.press(screen.getByRole('button'));

  expect(repository.updateProfile).toHaveBeenCalledWith({
    firstName: 'Jamie',
    lastName: 'Rios',
    phone: '203-555-0199',
  });
  expect(repository.updateProfile.mock.calls[0]![0]).not.toHaveProperty('email');
});

test('a name-only save for a member with no phone never sends phone ""', async () => {
  repository.getProfile.mockResolvedValue({
    firstName: 'Jamie',
    lastName: 'Rios',
    email: 'jrios@example.org',
    phone: null,
  });
  await render(<ProfileEditScreen />);
  await screen.findByText('jrios@example.org');

  await fireEvent.changeText(screen.getByLabelText('Last name'), 'Rivas');
  await fireEvent.press(screen.getByRole('button'));

  expect(repository.updateProfile).toHaveBeenCalledWith({ firstName: 'Jamie', lastName: 'Rivas' });
  expect(repository.updateProfile.mock.calls[0]![0]).not.toHaveProperty('phone');
});

test('clearing a stored phone sends null after the member confirms', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<ProfileEditScreen />);
  await screen.findByText('jrios@example.org');

  await fireEvent.changeText(screen.getByLabelText('Phone'), '');
  await fireEvent.press(screen.getByRole('button'));
  expect(repository.updateProfile).not.toHaveBeenCalled();

  const buttons = alertSpy.mock.calls[0]![2]!;
  buttons.find((button) => button.style === 'destructive')!.onPress?.();

  await waitFor(() =>
    expect(repository.updateProfile).toHaveBeenCalledWith({
      firstName: 'Jamie',
      lastName: 'Rios',
      phone: null,
    }),
  );
  alertSpy.mockRestore();
});

test("a 400 shows the server's detail", async () => {
  repository.updateProfile.mockRejectedValue(
    new ApiError({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Phone must be a valid number.',
      traceId: 't',
    }),
  );
  await render(<ProfileEditScreen />);
  await screen.findByText('jrios@example.org');

  await fireEvent.changeText(screen.getByLabelText('Phone'), 'abc');
  await fireEvent.press(screen.getByRole('button'));

  expect(await screen.findByText('Phone must be a valid number.')).toBeTruthy();
});

test('a profile that cannot load shows an error and Try again reloads it', async () => {
  repository.getProfile.mockRejectedValueOnce(new TypeError('Network request failed'));
  await render(<ProfileEditScreen />);

  expect(await screen.findByRole('alert')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('jrios@example.org')).toBeTruthy();
});
