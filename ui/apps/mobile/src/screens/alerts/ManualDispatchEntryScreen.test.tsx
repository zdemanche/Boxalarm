import { act, fireEvent, render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { ManualDispatchEntryScreen } from './ManualDispatchEntryScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('R3-A: the locality choice is required, and "Other town" sends the typed town', async () => {
  const submit = jest.spyOn(mockAlertsRepository, 'submitManualDispatch');
  const { getByLabelText, findByLabelText, findByRole, findByText } = await render(
    <ManualDispatchEntryScreen />,
  );

  const incident = await findByLabelText('Incident type');
  await act(async () => {
    fireEvent.changeText(incident, 'Structure fire');
    fireEvent.changeText(getByLabelText('Address'), '123 Main St');
    fireEvent.changeText(getByLabelText('Cross streets'), 'Main & Elm');
    fireEvent.changeText(getByLabelText('Narrative'), 'Mutual aid');
    fireEvent.changeText(getByLabelText('Operator-entered reference'), 'ext-2');
  });

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  });
  expect(await findByText('Choose the town or village.')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();

  const other = await findByRole('radio', { name: 'Other town…' });
  await act(async () => {
    fireEvent.press(other);
  });
  const otherName = await findByLabelText('Other town name');
  await act(async () => {
    fireEvent.changeText(otherName, 'Bridgeport');
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  });

  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '123 Main St',
      locality: { town: 'Bridgeport', choice: 'OTHER' },
    }),
  );
  submit.mockRestore();
});

test('submitting a valid manual entry navigates to the new dispatch roster', async () => {
  const { getByLabelText, findByRole } = await render(<ManualDispatchEntryScreen />);

  fireEvent.changeText(getByLabelText('Incident type'), 'Structure fire');
  fireEvent.changeText(getByLabelText('Address'), '12 Elm St');
  fireEvent.changeText(getByLabelText('Cross streets'), 'Main & Elm');
  await act(async () => {
    fireEvent.press(await findByRole('radio', { name: 'Nichols' }));
  });
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
