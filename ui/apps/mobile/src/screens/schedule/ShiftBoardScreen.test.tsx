import { fireEvent, render } from '@testing-library/react-native';
import { ShiftBoardScreen } from './ShiftBoardScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('lists shifts with their station and coverage status', async () => {
  const { findByText, findAllByText } = await render(<ShiftBoardScreen />);

  expect(await findByText(/Partially filled/i)).toBeTruthy();
  expect((await findAllByText('STATION-1')).length).toBeGreaterThan(0);
});

test('selecting a shift opens its detail', async () => {
  const { findAllByText } = await render(<ShiftBoardScreen />);

  fireEvent.press((await findAllByText('STATION-1'))[0]!);
  expect(mockNavigate).toHaveBeenCalledWith('ShiftDetail', { shiftId: 'SHIFT-0511' });
});
