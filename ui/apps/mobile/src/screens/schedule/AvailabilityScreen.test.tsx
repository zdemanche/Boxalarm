import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
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

test('announces the confirmation for screen reader users, since the screen swaps entirely', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByRole } = await render(<AvailabilityScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/marked unavailable/i));
  announceSpy.mockRestore();
});
