import { fireEvent, render, screen } from '@testing-library/react-native';
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
