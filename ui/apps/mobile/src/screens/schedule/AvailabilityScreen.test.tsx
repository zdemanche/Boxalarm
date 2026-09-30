import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { AvailabilityScreen, nextSixAm, presetWindow } from './AvailabilityScreen';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
}));

test('nothing is pre-selected: submitting without a duration asks for one and sends nothing', async () => {
  const submitSpy = jest.spyOn(mockScheduleRepository, 'markUnavailable');
  const { findByRole, findAllByRole } = await render(<AvailabilityScreen />);

  const radios = await findAllByRole('radio');
  expect(radios.every((radio) => radio.props.accessibilityState.checked === false)).toBe(true);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect((await findByRole('alert')).props.children).toMatch(/Choose how long/);
  expect(submitSpy).not.toHaveBeenCalled();
  submitSpy.mockRestore();
});

test('picking a preset and a reason marks unavailable for that window and confirms', async () => {
  const submitSpy = jest.spyOn(mockScheduleRepository, 'markUnavailable');
  const { findByText, findByRole } = await render(<AvailabilityScreen />);

  await act(async () => {
    fireEvent.press(await findByText('24 hours'));
  });
  await act(async () => {
    fireEvent.press(await findByText('Travel'));
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect(submitSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Travel');
  const [startAt, endAt] = submitSpy.mock.calls[0]!;
  expect(Date.parse(endAt) - Date.parse(startAt)).toBe(24 * 60 * 60 * 1000);
  expect(await findByText(/^Marked unavailable until/)).toBeTruthy();
  fireEvent.press(await findByText('Done'));
  expect(mockGoBack).toHaveBeenCalled();
  submitSpy.mockRestore();
});

test('Custom uses tap steppers, not typed dates', async () => {
  const { findByText, findByRole, queryByLabelText } = await render(<AvailabilityScreen />);

  await act(async () => {
    fireEvent.press(await findByText('Custom dates…'));
  });

  expect(await findByRole('button', { name: 'Until one day later' })).toBeTruthy();
  expect(await findByRole('button', { name: 'From one hour earlier' })).toBeTruthy();
  expect(queryByLabelText('Start date')).toBeNull();
});

test('a queued mark-off is reported as saved on the phone, not as in effect', async () => {
  const submitSpy = jest
    .spyOn(mockScheduleRepository, 'markUnavailable')
    .mockResolvedValueOnce({ outboxId: 'availability-m-1-1' });
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByText, findByRole } = await render(<AvailabilityScreen />);

  await act(async () => {
    fireEvent.press(await findByText('1 week'));
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect(await findByText('Saved on this phone — not in effect yet')).toBeTruthy();
  expect(await findByText(/You may still be alerted until this syncs/)).toBeTruthy();
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/may still be alerted/));
  submitSpy.mockRestore();
  announceSpy.mockRestore();
});

test('a failure to queue says plainly that the member is not marked off', async () => {
  const submitSpy = jest
    .spyOn(mockScheduleRepository, 'markUnavailable')
    .mockRejectedValueOnce(new Error('disk full'));
  const { findByText, findByRole } = await render(<AvailabilityScreen />);

  await act(async () => {
    fireEvent.press(await findByText('3 days'));
  });
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Mark unavailable' }));
  });

  expect((await findByRole('alert')).props.children).toMatch(/not marked unavailable/);
  submitSpy.mockRestore();
});

test('tonight runs until the next 06:00', () => {
  expect(nextSixAm(new Date(2026, 8, 29, 21, 30)).getTime()).toBe(
    new Date(2026, 8, 30, 6, 0).getTime(),
  );
  expect(nextSixAm(new Date(2026, 8, 29, 2, 0)).getTime()).toBe(
    new Date(2026, 8, 29, 6, 0).getTime(),
  );
  const { start, end } = presetWindow('1w', new Date(2026, 8, 29, 21, 30, 45));
  expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
});
