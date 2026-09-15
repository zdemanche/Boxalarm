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

beforeEach(async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  mockRouteParams.dispatchId = dispatchId;
  mockConnectivity.isOnline = true;
});

test('lists each roster entry with name, response status, and quals', async () => {
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText('Jamie Rios')).toBeTruthy();
  expect(await findByText(/awaiting response/i)).toBeTruthy();
  expect(await findByText(/FF1/)).toBeTruthy();
});

test('reflects a recorded response after submitResponse resolves', async () => {
  await mockAlertsRepository.submitResponse(
    mockRouteParams.dispatchId,
    'RESPONDING',
    '2026-09-13T15:00:00Z',
  );
  const { findByText } = await render(<RosterScreen />);

  expect(await findByText(/^responding$/i)).toBeTruthy();
});

test('shows an honest offline state instead of a stale or empty roster - F1.7 requires connectivity', async () => {
  mockConnectivity.isOnline = false;
  const { findByText, queryByText } = await render(<RosterScreen />);

  expect(await findByText(/offline.*will resume/i)).toBeTruthy();
  expect(queryByText('Jamie Rios')).toBeNull();
});
