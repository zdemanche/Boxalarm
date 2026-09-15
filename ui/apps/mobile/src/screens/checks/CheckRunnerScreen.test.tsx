import { act, fireEvent, render } from '@testing-library/react-native';
import { CheckRunnerScreen } from './CheckRunnerScreen';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';

const mockRoute = { params: { apparatusId: 'APP-ENGINE-2' } };
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

test('lists every item from the apparatus\u2019s checklist template', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  expect(await findByText('Tires and wheels')).toBeTruthy();
  expect(await findByText('SCBA units present and charged')).toBeTruthy();
});

test('marking every item pass enables completing the check', async () => {
  const { findByText, findAllByText, queryByRole } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  expect(queryByRole('button', { name: 'Complete check' })).toBeNull();

  const passButtons = await findAllByText('Pass');
  for (const button of passButtons) {
    await act(async () => {
      fireEvent.press(button);
    });
  }

  expect(await findByText('Complete check')).toBeTruthy();
});

test('completing the check submits optimistically and confirms immediately, no spinner wait', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitChecklistRun');
  const { findByText, findAllByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  const passButtons = await findAllByText('Pass');
  for (const button of passButtons) {
    await act(async () => {
      fireEvent.press(button);
    });
  }
  await act(async () => {
    fireEvent.press(await findByText('Complete check'));
  });

  expect(await findByText(/check complete/i)).toBeTruthy();
  expect(submitSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      apparatusId: 'APP-ENGINE-2',
      itemResults: expect.arrayContaining([expect.objectContaining({ code: 'TIRES', pass: true })]),
    }),
  );
  submitSpy.mockRestore();
});

test('linking to defect report carries the apparatus id along', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  fireEvent.press(await findByText('Report a defect'));
  expect(mockNavigate).toHaveBeenCalledWith('DefectReport', { apparatusId: 'APP-ENGINE-2' });
});
