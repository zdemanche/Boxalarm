import { act, fireEvent, render } from '@testing-library/react-native';
import { DefectReportScreen } from './DefectReportScreen';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';

const mockRoute = { params: { apparatusId: 'APP-ENGINE-2' } };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ goBack: jest.fn() }),
}));

test('mentions that a photo attachment is not yet connected', async () => {
  const { findByText } = await render(<DefectReportScreen />);
  expect(await findByText(/not yet connected/i)).toBeTruthy();
});

test('submitting a defect report calls submitDefect with the entered description and severity', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitDefect');
  const { findByText, findByPlaceholderText } = await render(<DefectReportScreen />);

  const input = await findByPlaceholderText('Describe the defect');
  await act(async () => {
    fireEvent.changeText(input, 'Low tire pressure, rear axle');
  });
  await act(async () => {
    fireEvent.press(await findByText('Major'));
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit defect report'));
  });

  expect(submitSpy).toHaveBeenCalledWith({
    apparatusId: 'APP-ENGINE-2',
    description: 'Low tire pressure, rear axle',
    severity: 'MAJOR',
  });
  submitSpy.mockRestore();
});
