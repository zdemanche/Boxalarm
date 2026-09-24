import { act, fireEvent, render } from '@testing-library/react-native';
import { ManualDispatchEntryScreen } from './ManualDispatchEntryScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('submitting a valid manual entry navigates to the new dispatch roster', async () => {
  const { getByLabelText, findByRole } = await render(<ManualDispatchEntryScreen />);

  fireEvent.changeText(getByLabelText('Incident type'), 'Structure fire');
  fireEvent.changeText(getByLabelText('Address'), '12 Elm St');
  fireEvent.changeText(getByLabelText('Cross streets'), 'Main & Elm');
  fireEvent.changeText(getByLabelText('Narrative'), 'Smoke showing');
  fireEvent.changeText(getByLabelText('Operator-entered reference'), 'ext-1');
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  });

  expect(mockNavigate).toHaveBeenCalledWith('Roster', {
    dispatchId: expect.any(String) as unknown as string,
  });
});

test('leaves the form usable without crashing when required fields are empty', async () => {
  const { findByRole } = await render(<ManualDispatchEntryScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  });

  expect(await findByRole('button', { name: 'Submit dispatch' })).toBeTruthy();
});
