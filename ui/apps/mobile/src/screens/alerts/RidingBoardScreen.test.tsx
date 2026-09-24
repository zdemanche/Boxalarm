import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { ApiError } from '../../lib/apiClient';
import { RidingBoardScreen } from './RidingBoardScreen';

const mockRouteParams: { dispatchId: string } = { dispatchId: '' };
const mockIsFocused = { current: true };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockRouteParams }),
  useIsFocused: () => mockIsFocused.current,
}));

const mockConnectivity: { isOnline: boolean } = { isOnline: true };
jest.mock('../../sync/ConnectivityContext', () => ({
  useConnectivity: () => mockConnectivity,
}));

// A controllable repository that delegates to mockAlertsRepository by default, so existing
// behavior is unchanged, but lets individual tests override e.g. assignRidingSeat to reject
// with a specific ApiError - needed to exercise the 401/403/409/network branches in assign().
const mockRepository = {
  triggerSelfTest: jest.fn((...args: Parameters<typeof mockAlertsRepository.triggerSelfTest>) =>
    mockAlertsRepository.triggerSelfTest(...args),
  ),
  getSelfTestRun: jest.fn((...args: Parameters<typeof mockAlertsRepository.getSelfTestRun>) =>
    mockAlertsRepository.getSelfTestRun(...args),
  ),
  getDispatch: jest.fn((...args: Parameters<typeof mockAlertsRepository.getDispatch>) =>
    mockAlertsRepository.getDispatch(...args),
  ),
  getRoster: jest.fn((...args: Parameters<typeof mockAlertsRepository.getRoster>) =>
    mockAlertsRepository.getRoster(...args),
  ),
  submitResponse: jest.fn((...args: Parameters<typeof mockAlertsRepository.submitResponse>) =>
    mockAlertsRepository.submitResponse(...args),
  ),
  submitManualDispatch: jest.fn(
    (...args: Parameters<typeof mockAlertsRepository.submitManualDispatch>) =>
      mockAlertsRepository.submitManualDispatch(...args),
  ),
  getReceipts: jest.fn((...args: Parameters<typeof mockAlertsRepository.getReceipts>) =>
    mockAlertsRepository.getReceipts(...args),
  ),
  getRidingBoard: jest.fn((...args: Parameters<typeof mockAlertsRepository.getRidingBoard>) =>
    mockAlertsRepository.getRidingBoard(...args),
  ),
  assignRidingSeat: jest.fn((...args: Parameters<typeof mockAlertsRepository.assignRidingSeat>) =>
    mockAlertsRepository.assignRidingSeat(...args),
  ),
};

jest.mock('../../features/alerts/apiAlertsRepository', () => ({
  useAlertsRepository: () => mockRepository,
}));

beforeEach(async () => {
  const { dispatchId } = await mockAlertsRepository.triggerSelfTest();
  await mockAlertsRepository.submitResponse(dispatchId, 'RESPONDING', 10);
  mockRouteParams.dispatchId = dispatchId;
  mockConnectivity.isOnline = true;
  mockIsFocused.current = true;
  mockRepository.assignRidingSeat.mockReset();
  mockRepository.assignRidingSeat.mockImplementation((...args) =>
    mockAlertsRepository.assignRidingSeat(...args),
  );
  mockRepository.getRidingBoard.mockReset();
  mockRepository.getRidingBoard.mockImplementation((...args) =>
    mockAlertsRepository.getRidingBoard(...args),
  );
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

async function attemptAssignment(screen: Awaited<ReturnType<typeof render>>) {
  const assignButtons = await screen.findAllByRole('button', { name: 'Assign' });
  await act(async () => {
    fireEvent.press(assignButtons[0] as never);
  });
  const memberButton = await screen.findByText('Jamie Rios');
  await act(async () => {
    fireEvent.press(memberButton);
  });
}

test('a 409 conflict during assignment is labelled as a reassignment, not a generic failure', async () => {
  mockRepository.assignRidingSeat.mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Version mismatch',
      traceId: 'trace-409',
    }),
  );

  const screen = await render(<RidingBoardScreen />);
  await screen.findByText('Engine 301');
  await attemptAssignment(screen);

  expect(await screen.findByText(/was reassigned by another officer/i)).toBeTruthy();
});

test('a 401 during assignment tells the officer to sign in again and hides further Assign actions', async () => {
  mockRepository.assignRidingSeat.mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Token expired',
      traceId: 'trace-401',
    }),
  );

  const screen = await render(<RidingBoardScreen />);
  await screen.findByText('Engine 301');
  await attemptAssignment(screen);

  expect(await screen.findByText(/session has expired/i)).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: 'Assign' })).toHaveLength(0);
});

test('a 403 during assignment tells the officer they are not authorized, not that a reassignment happened', async () => {
  mockRepository.assignRidingSeat.mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Cedar denied apparatus:assign',
      traceId: 'trace-403',
    }),
  );

  const screen = await render(<RidingBoardScreen />);
  await screen.findByText('Engine 301');
  await attemptAssignment(screen);

  expect(await screen.findByText(/not authorized/i)).toBeTruthy();
});

test('a network failure during assignment is reported as a connectivity problem, not a reassignment', async () => {
  mockRepository.assignRidingSeat.mockRejectedValueOnce(new TypeError('Failed to fetch'));

  const screen = await render(<RidingBoardScreen />);
  await screen.findByText('Engine 301');
  await attemptAssignment(screen);

  expect(await screen.findByText(/could not reach the server/i)).toBeTruthy();
});

test('a poll failure surfaces a stale-data indicator instead of silently keeping the old board forever', async () => {
  mockRepository.getRidingBoard.mockRejectedValue(new TypeError('Failed to fetch'));

  const { findByText } = await render(<RidingBoardScreen />);

  expect(await findByText(/data stopped updating/i)).toBeTruthy();
});

test('an offline assignment is queued as "Pending sync" and flushed automatically once reconnected', async () => {
  mockConnectivity.isOnline = false;

  const screen = await render(<RidingBoardScreen />);
  await screen.findByText('Engine 301');
  await attemptAssignment(screen);

  expect(await screen.findByText(/pending sync/i)).toBeTruthy();
  expect(mockRepository.assignRidingSeat).not.toHaveBeenCalled();

  mockConnectivity.isOnline = true;
  await act(async () => {
    screen.rerender(<RidingBoardScreen />);
  });

  await waitFor(() => {
    expect(mockRepository.assignRidingSeat).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.queryByText(/pending sync/i)).toBeNull();
  });
});

test('polling stops while the screen is unfocused and resumes immediately once it regains focus', async () => {
  jest.useFakeTimers();
  try {
    const screen = await render(<RidingBoardScreen />);
    await screen.findByText('Engine 301');
    expect(mockRepository.getRidingBoard).toHaveBeenCalledTimes(1);

    // React Navigation's native-stack keeps a screen mounted when navigating away from it
    // (e.g. to another screen further up the AlertsStack) - simulate that by dropping focus
    // without unmounting.
    mockIsFocused.current = false;
    await act(async () => {
      screen.rerender(<RidingBoardScreen />);
    });

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockRepository.getRidingBoard).toHaveBeenCalledTimes(1);

    mockIsFocused.current = true;
    await act(async () => {
      screen.rerender(<RidingBoardScreen />);
    });

    expect(mockRepository.getRidingBoard).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});
