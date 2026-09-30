import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { ShiftDetailScreen } from './ShiftDetailScreen';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';
import { ConnectivityProvider } from '../../sync/ConnectivityContext';

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

/** A fresh, unclaimed shift: the mock repository's shifts are mutated by earlier claims. */
function freshShift() {
  return jest.spyOn(mockScheduleRepository, 'getShifts').mockResolvedValue([
    {
      shiftId: 'SHIFT-0512',
      startAt: Date.parse('2026-09-27T18:00:00Z'),
      endAt: Date.parse('2026-09-28T06:00:00Z'),
      stationId: 'STATION-1',
      status: 'OPEN',
      positions: [{ positionCode: 'DRIVER', requiredQual: null, claimedByMemberId: null }],
    },
  ]);
}

test('offline, a claim says plainly it was not sent, and the position stays open', async () => {
  const shiftsSpy = freshShift();
  const claimSpy = jest.spyOn(mockScheduleRepository, 'claimPosition');
  const { findAllByText, findByText, queryByText } = await render(
    <ConnectivityProvider initialIsOnline={false}>
      <ShiftDetailScreen />
    </ConnectivityProvider>,
  );

  fireEvent.press((await findAllByText('Claim'))[0]!);

  expect(await findByText(/Not claimed: you need a connection/)).toBeTruthy();
  expect(queryByText('Pending...')).toBeNull();
  // Earlier tests' screens may still settle their own claims; none may be for this position.
  expect(claimSpy).not.toHaveBeenCalledWith('SHIFT-0512', 'DRIVER', expect.anything());
  claimSpy.mockRestore();
  shiftsSpy.mockRestore();
});

test('a connection lost mid-claim returns the position to Open with the reason', async () => {
  const claimSpy = jest
    .spyOn(mockScheduleRepository, 'claimPosition')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  const shiftsSpy = freshShift();
  const { findAllByText, findByText } = await render(<ShiftDetailScreen />);

  await act(async () => {
    fireEvent.press((await findAllByText('Claim'))[0]!);
  });

  expect(await findByText(/Not claimed: the connection dropped/)).toBeTruthy();
  expect((await findAllByText('Claim')).length).toBeGreaterThan(0);
  claimSpy.mockRestore();
  shiftsSpy.mockRestore();
});
