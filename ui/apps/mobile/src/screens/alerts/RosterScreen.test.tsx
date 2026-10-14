import { act, fireEvent, render } from '@testing-library/react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { resetMemberNamesCache } from '../../features/alerts/useMemberNames';
import { RosterScreen } from './RosterScreen';

const mockRouteParams: { dispatchId: string } = { dispatchId: '' };
const mockIsFocused = { current: true };
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockRouteParams }),
  useIsFocused: () => mockIsFocused.current,
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));

const mockConnectivity: { isOnline: boolean } = { isOnline: true };
jest.mock('../../sync/ConnectivityContext', () => ({
  useConnectivity: () => mockConnectivity,
}));

// A controllable repository that delegates to mockAlertsRepository by default, so existing
// behavior is unchanged, but lets a test override getRoster to reject - needed to exercise the
// poll-failure/stale-indicator path that a plain setInterval-with-no-.catch() can't surface.
const mockRepository = {
  getRoster: jest.fn((...args: Parameters<typeof mockAlertsRepository.getRoster>) =>
    mockAlertsRepository.getRoster(...args),
  ),
  listMemberNames: jest.fn(() => mockAlertsRepository.listMemberNames()),
};

jest.mock('../../features/alerts/apiAlertsRepository', () => ({
  useAlertsRepository: () => mockRepository,
}));

beforeEach(async () => {
  resetMemberNamesCache();
  mockNavigate.mockClear();
  (useOptionalAuth as jest.Mock).mockReturnValue({ roles: ['MEMBER'] });
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  mockRouteParams.dispatchId = dispatchId;
  mockConnectivity.isOnline = true;
  mockIsFocused.current = true;
  mockRepository.listMemberNames.mockReset();
  mockRepository.listMemberNames.mockImplementation(() => mockAlertsRepository.listMemberNames());
  mockRepository.getRoster.mockReset();
  mockRepository.getRoster.mockImplementation((...args) => mockAlertsRepository.getRoster(...args));
});

test('lists each roster entry with name, response status, and quals', async () => {
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(await findByText(/awaiting response/i)).toBeTruthy();
  expect(await findByText(/FF1/)).toBeTruthy();
});

test('reflects a recorded response after submitResponse resolves', async () => {
  await mockAlertsRepository.submitResponse(mockRouteParams.dispatchId, 'RESPONDING', {
    minutes: 15,
    qualifier: null,
  });
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/responding/i)).toBeTruthy();
});

test('a direct-to-scene response is labelled distinctly from a station response', async () => {
  await mockAlertsRepository.submitResponse(mockRouteParams.dispatchId, 'DIRECT_TO_SCENE', {
    minutes: 5,
    qualifier: null,
  });
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/direct to scene/i)).toBeTruthy();
});

test('offline with nothing loaded yet says the roster will resume', async () => {
  mockConnectivity.isOnline = false;
  const { findByText, queryByText } = await render(<RosterScreen />);

  expect(await findByText(/offline.*will resume/i)).toBeTruthy();
  expect(queryByText('Jamie Rios')).toBeNull();
});

test('B2-229: going offline keeps the last roster on screen, marked not live with its time', async () => {
  const screen = await render(<RosterScreen />);
  expect(await screen.findByText('Jamie Rios')).toBeTruthy();

  mockConnectivity.isOnline = false;
  await screen.rerender(<RosterScreen />);

  expect(screen.getByText('Jamie Rios')).toBeTruthy();
  expect(
    screen.getByText(/offline\. this roster was last updated .* and is not live/i),
  ).toBeTruthy();
});

test('B2-070: an officer can open the riding board from the roster, a member cannot', async () => {
  const member = await render(<RosterScreen />);
  await member.findByText('Jamie Rios');
  expect(member.queryByRole('button', { name: 'Riding assignments' })).toBeNull();
  await member.unmount();

  (useOptionalAuth as jest.Mock).mockReturnValue({ roles: ['OFFICER'] });
  const officer = await render(<RosterScreen />);
  await fireEvent.press(await officer.findByRole('button', { name: 'Riding assignments' }));

  expect(mockNavigate).toHaveBeenCalledWith('RidingBoard', {
    dispatchId: mockRouteParams.dispatchId,
  });
});

test('a poll failure surfaces a stale-data indicator instead of silently keeping the old roster forever', async () => {
  mockRepository.getRoster.mockRejectedValue(new TypeError('Failed to fetch'));

  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/data stopped updating/i)).toBeTruthy();
});

test('polling stops while the screen is unfocused and resumes immediately once it regains focus', async () => {
  jest.useFakeTimers();
  try {
    const screen = await render(<RosterScreen />);
    await screen.findByText('Jamie Rios');
    expect(mockRepository.getRoster).toHaveBeenCalledTimes(1);

    // React Navigation's native-stack keeps a screen mounted when navigating away from it -
    // simulate that by dropping focus without unmounting.
    mockIsFocused.current = false;
    await act(async () => {
      screen.rerender(<RosterScreen />);
    });

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockRepository.getRoster).toHaveBeenCalledTimes(1);

    mockIsFocused.current = true;
    await act(async () => {
      screen.rerender(<RosterScreen />);
    });

    expect(mockRepository.getRoster).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

const nameless = {
  memberId: 'sub-1',
  name: 'sub-1',
  ackStatus: 'UNANSWERED' as const,
  eta: null,
  assignedApparatusId: null,
  quals: [],
  lastAnsweredTone: null,
};

test('a roster entry with no name shows the directory name, not the member ID', async () => {
  mockRepository.getRoster.mockResolvedValue([nameless]);
  mockRepository.listMemberNames.mockResolvedValue({ 'sub-1': 'Jamie Rios' });

  const { findByText, queryByText } = await render(<RosterScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(queryByText('sub-1')).toBeNull();
});

test('when the member directory fails the roster still renders by member ID with a notice', async () => {
  mockRepository.getRoster.mockResolvedValue([nameless]);
  mockRepository.listMemberNames.mockRejectedValue(new Error('personnel down'));

  const { findByText } = await render(<RosterScreen />);

  expect(await findByText('sub-1')).toBeTruthy();
  expect(await findByText(/names couldn't load/i)).toBeTruthy();
});
