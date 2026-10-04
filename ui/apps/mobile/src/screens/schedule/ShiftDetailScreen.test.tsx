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
  return jest.spyOn(mockScheduleRepository, 'getShift').mockResolvedValue({
    shiftId: 'SHIFT-0512',
    startAt: Date.parse('2026-09-27T18:00:00Z'),
    endAt: Date.parse('2026-09-28T06:00:00Z'),
    stationId: 'STATION-1',
    status: 'OPEN',
    positions: [{ positionCode: 'DRIVER', requiredQual: null, claimedByMemberId: null }],
  });
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

/** A shift with one position this member already holds (claimedByMe), per handleGetShift. */
function shiftWithMyClaimedPosition() {
  return jest.spyOn(mockScheduleRepository, 'getShift').mockResolvedValue({
    shiftId: 'SHIFT-0512',
    startAt: Date.parse('2026-09-27T18:00:00Z'),
    endAt: Date.parse('2026-09-28T06:00:00Z'),
    stationId: 'STATION-1',
    status: 'OPEN',
    positions: [
      { positionCode: 'DRIVER', requiredQual: null, claimedByMemberId: 'MBR-0012', claimedByMe: true },
    ],
  });
}

test('a position this member already holds shows "Claimed by you" on load, not the generic "Claimed" (#146/#148)', async () => {
  const shiftSpy = shiftWithMyClaimedPosition();
  const { findByText, queryByText } = await render(<ShiftDetailScreen />);

  expect(await findByText('Claimed by you')).toBeTruthy();
  expect(queryByText('Claimed')).toBeNull();
  shiftSpy.mockRestore();
});

test('give back releases a claimed position, returning it to Open (#146/#148)', async () => {
  const shiftSpy = shiftWithMyClaimedPosition();
  const releaseSpy = jest
    .spyOn(mockScheduleRepository, 'releasePosition')
    .mockResolvedValue(undefined);
  const { findByText, queryByText } = await render(<ShiftDetailScreen />);
  await findByText('Claimed by you');
  const giveBackButton = await findByText('Give back');

  await act(async () => {
    fireEvent.press(giveBackButton);
  });

  expect(await findByText('Open')).toBeTruthy();
  expect(queryByText('Claimed by you')).toBeNull();
  expect(releaseSpy).toHaveBeenCalledWith('SHIFT-0512', 'DRIVER');
  releaseSpy.mockRestore();
  shiftSpy.mockRestore();
});

test('a give-back failure keeps the position claimed by you and says so, not a silent no-op', async () => {
  const shiftSpy = shiftWithMyClaimedPosition();
  const releaseSpy = jest
    .spyOn(mockScheduleRepository, 'releasePosition')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  const { findByText } = await render(<ShiftDetailScreen />);
  await findByText('Claimed by you');
  const giveBackButton = await findByText('Give back');

  await act(async () => {
    fireEvent.press(giveBackButton);
  });

  expect(await findByText(/Could not give back this position/)).toBeTruthy();
  expect(await findByText('Claimed by you')).toBeTruthy();
  releaseSpy.mockRestore();
  shiftSpy.mockRestore();
});

test('propose swap sends the request to the entered member and clears the field, announced (#146/#148)', async () => {
  const shiftSpy = shiftWithMyClaimedPosition();
  const swapSpy = jest.spyOn(mockScheduleRepository, 'proposeSwap').mockResolvedValue(undefined);
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByText, findByLabelText } = await render(<ShiftDetailScreen />);
  await findByText('Claimed by you');

  const input = await findByLabelText('Propose swap to member ID');
  fireEvent.changeText(input, 'MBR-0099');
  const proposeButton = await findByText('Propose swap');
  await act(async () => {
    fireEvent.press(proposeButton);
  });

  expect(swapSpy).toHaveBeenCalledWith('SHIFT-0512', 'DRIVER', 'MBR-0099');
  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/swap proposed, pending approval/i));
  expect((await findByLabelText('Propose swap to member ID')).props.value).toBe('');
  swapSpy.mockRestore();
  announceSpy.mockRestore();
  shiftSpy.mockRestore();
});

test('propose swap does nothing when no member id has been entered', async () => {
  const shiftSpy = shiftWithMyClaimedPosition();
  const swapSpy = jest.spyOn(mockScheduleRepository, 'proposeSwap');
  const { findByText } = await render(<ShiftDetailScreen />);
  await findByText('Claimed by you');
  const proposeButton = await findByText('Propose swap');

  await act(async () => {
    fireEvent.press(proposeButton);
  });

  expect(swapSpy).not.toHaveBeenCalled();
  swapSpy.mockRestore();
  shiftSpy.mockRestore();
});
