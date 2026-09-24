import { render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { RosterScreen } from './RosterScreen';

const mockRouteParams: { dispatchId: string } = { dispatchId: '' };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockRouteParams }),
}));

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
};

jest.mock('../../features/alerts/apiAlertsRepository', () => ({
  useAlertsRepository: () => mockRepository,
}));

beforeEach(async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  mockRouteParams.dispatchId = dispatchId;
  mockConnectivity.isOnline = true;
  mockRepository.getRoster.mockImplementation((...args) => mockAlertsRepository.getRoster(...args));
});

test('lists each roster entry with name, response status, and quals', async () => {
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(await findByText(/awaiting response/i)).toBeTruthy();
  expect(await findByText(/FF1/)).toBeTruthy();
});

test('reflects a recorded response after submitResponse resolves', async () => {
  await mockAlertsRepository.submitResponse(mockRouteParams.dispatchId, 'RESPONDING', 15);
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/responding/i)).toBeTruthy();
});

test('a direct-to-scene response is labelled distinctly from a station response', async () => {
  await mockAlertsRepository.submitResponse(mockRouteParams.dispatchId, 'DIRECT_TO_SCENE', 5);
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/direct to scene/i)).toBeTruthy();
});

test('shows an honest offline state instead of a stale or empty roster - F1.7 requires connectivity', async () => {
  mockConnectivity.isOnline = false;
  const { findByText, queryByText } = await render(<RosterScreen />);

  expect(await findByText(/offline.*will resume/i)).toBeTruthy();
  expect(queryByText('Jamie Rios')).toBeNull();
});

test('a poll failure surfaces a stale-data indicator instead of silently keeping the old roster forever', async () => {
  mockRepository.getRoster.mockRejectedValue(new TypeError('Failed to fetch'));

  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/data stopped updating/i)).toBeTruthy();
});
