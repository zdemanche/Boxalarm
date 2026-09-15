import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { ShiftDetailScreen } from './ShiftDetailScreen';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';

const mockRoute = { params: { shiftId: 'SHIFT-0512' } };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
}));

test('lists each position with its claim state', async () => {
  const { findByText, findAllByText } = await render(<ShiftDetailScreen />);

  expect(await findByText('DRIVER')).toBeTruthy();
  expect(await findByText('INTERIOR')).toBeTruthy();
  expect((await findAllByText('Open')).length).toBe(2);
});

test('claiming an open position shows Pending immediately, then Claimed by you', async () => {
  const { findByText, findAllByText } = await render(<ShiftDetailScreen />);

  await act(async () => {
    fireEvent.press((await findAllByText('Claim'))[0]!);
  });

  expect(await findByText('Claimed by you')).toBeTruthy();
});

test('claiming a position that is already taken shows the honest outcome, not a false confirm', async () => {
  jest.spyOn(mockScheduleRepository, 'claimPosition').mockResolvedValueOnce('ALREADY_TAKEN');
  const { findByText, findAllByText } = await render(<ShiftDetailScreen />);

  await act(async () => {
    fireEvent.press((await findAllByText('Claim'))[0]!);
  });

  expect(await findByText(/already taken/i)).toBeTruthy();
});

test('announces the claim result for screen reader users once it resolves', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findAllByText } = await render(<ShiftDetailScreen />);

  await act(async () => {
    fireEvent.press((await findAllByText('Claim'))[0]!);
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/claimed by you/i));
  announceSpy.mockRestore();
});
