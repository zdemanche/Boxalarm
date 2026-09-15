import { act, fireEvent, render } from '@testing-library/react-native';
import { AvailabilityScreen } from './AvailabilityScreen';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';

test('marking unavailable submits the reason and confirms', async () => {
  const submitSpy = jest.spyOn(mockScheduleRepository, 'markUnavailable');
  const { findByText, findByPlaceholderText, findByRole } = await render(<AvailabilityScreen />);

  const reasonInput = await findByPlaceholderText('Reason (optional)');
  await act(async () => {
    fireEvent.changeText(reasonInput, 'Vacation');
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect(submitSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Vacation');
  expect(await findByText(/marked unavailable/i)).toBeTruthy();
  submitSpy.mockRestore();
});
