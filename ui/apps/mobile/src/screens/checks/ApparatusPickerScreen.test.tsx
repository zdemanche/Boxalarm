import { fireEvent, render } from '@testing-library/react-native';
import { ApparatusPickerScreen } from './ApparatusPickerScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('lists each apparatus with its unit id and status', async () => {
  const { findByText } = await render(<ApparatusPickerScreen />);

  expect(await findByText('ENGINE-2')).toBeTruthy();
  expect(await findByText('LADDER-1')).toBeTruthy();
});

test('selecting an in-service apparatus navigates to the check runner', async () => {
  const { findByText } = await render(<ApparatusPickerScreen />);

  fireEvent.press(await findByText('ENGINE-2'));
  expect(mockNavigate).toHaveBeenCalledWith('CheckRunner', { apparatusId: 'APP-ENGINE-2' });
});
