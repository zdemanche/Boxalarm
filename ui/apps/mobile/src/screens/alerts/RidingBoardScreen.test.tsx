import { act, fireEvent, render } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { RidingBoardScreen } from './RidingBoardScreen';

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
  await mockAlertsRepository.submitResponse(dispatchId, 'RESPONDING', 10);
  mockRouteParams.dispatchId = dispatchId;
  mockConnectivity.isOnline = true;
});

test('shows in-service apparatus with its positions and flags an out-of-service unit with its reason', async () => {
  const { findByText } = await render(<RidingBoardScreen />);

  expect(await findByText('Engine 301')).toBeTruthy();
  expect(await findByText(/officer:.*unassigned/i)).toBeTruthy();
  expect(await findByText('Squad 309')).toBeTruthy();
  expect(await findByText(/out of service: scheduled maintenance/i)).toBeTruthy();
});

test('assigning a responding member to a vacant seat updates the board', async () => {
  const { findByText, findAllByRole } = await render(<RidingBoardScreen />);
  await findByText('Engine 301');

  const assignButtons = await findAllByRole('button', { name: 'Assign' });
  await act(async () => {
    fireEvent.press(assignButtons[0] as never);
  });

  const memberButton = await findByText('Jamie Rios');
  await act(async () => {
    fireEvent.press(memberButton);
  });

  expect(await findByText(/jamie rios/i)).toBeTruthy();
});

test('an out-of-service apparatus is not offered an Assign action for its seat', async () => {
  const { findByText, queryAllByRole } = await render(<RidingBoardScreen />);
  await findByText('Squad 309');

  // Engine 301 has 3 positions (all assignable); Squad 309 has 1, but it is out of service.
  expect(queryAllByRole('button', { name: 'Assign' })).toHaveLength(3);
});
