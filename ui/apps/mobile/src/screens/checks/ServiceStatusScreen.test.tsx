import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { ServiceStatusScreen } from './ServiceStatusScreen';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));
let mockParams = { unitId: 'E1', status: 'IN_SERVICE' };
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockParams }),
  useNavigation: () => ({ goBack: mockGoBack }),
}));
jest.mock('../../auth/AuthContext', () => ({
  useOptionalAuth: () => ({
    roles: ['OFFICER'],
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  }),
}));
let mockOnline = true;
jest.mock('../../sync/ConnectivityContext', () => ({
  useOptionalConnectivity: () => ({ isOnline: mockOnline }),
}));

const mockApiRequest = apiRequest as jest.Mock;

async function press(element: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(element);
  });
}

beforeEach(() => {
  mockApiRequest.mockReset();
  mockGoBack.mockClear();
  mockOnline = true;
  mockParams = { unitId: 'E1', status: 'IN_SERVICE' };
});

test('taking a unit out of service needs a reason and a confirmation, then PUTs it', async () => {
  mockApiRequest.mockResolvedValueOnce({ status: 204 });
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await render(<ServiceStatusScreen />);

  const takeOut = screen.getByRole('button', { name: 'Take E1 out of service' });
  expect(takeOut.props.accessibilityState?.disabled).toBe(true);
  await press(screen.getByRole('radio', { name: /Mechanical problem/ }));
  await press(screen.getByRole('button', { name: 'Take E1 out of service' }));
  // Nothing is sent until the member confirms.
  expect(mockApiRequest).not.toHaveBeenCalled();
  expect(
    screen.getByText(/Every member will see E1 out of service \(Mechanical problem\)/),
  ).toBeTruthy();

  await press(screen.getByRole('button', { name: 'Yes, take it out of service' }));

  expect(mockApiRequest).toHaveBeenCalledWith(
    'apparatus/E1/service-status',
    expect.anything(),
    expect.objectContaining({ method: 'PUT' }),
  );
  expect(JSON.parse(mockApiRequest.mock.calls[0][2].body as string)).toEqual({
    status: 'OUT_OF_SERVICE',
    reason: 'Mechanical problem',
  });
  expect(await screen.findByText('E1 is now out of service.')).toBeTruthy();
  expect(announce).toHaveBeenCalledWith('E1 is now out of service.');
  announce.mockRestore();
});

test('returning a unit to service sends no reason; Cancel backs out without sending', async () => {
  mockParams = { unitId: 'E1', status: 'OUT_OF_SERVICE' };
  mockApiRequest.mockResolvedValueOnce({ status: 204 });
  await render(<ServiceStatusScreen />);

  await press(screen.getByRole('button', { name: 'Return E1 to service' }));
  await press(screen.getByRole('button', { name: 'Cancel' }));
  expect(mockApiRequest).not.toHaveBeenCalled();

  await press(screen.getByRole('button', { name: 'Return E1 to service' }));
  await press(screen.getByRole('button', { name: 'Yes, return it to service' }));
  expect(JSON.parse(mockApiRequest.mock.calls[0][2].body as string)).toEqual({
    status: 'IN_SERVICE',
  });
  expect(await screen.findByText('E1 is back in service.')).toBeTruthy();
});

test('offline is refused plainly and nothing is sent', async () => {
  mockOnline = false;
  await render(<ServiceStatusScreen />);

  expect(
    screen.getByText(/You're offline\. Service status can only be changed with a connection/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Take E1 out of service' })).toBeNull();
  expect(mockApiRequest).not.toHaveBeenCalled();
});

test('a refusal says nothing was changed', async () => {
  mockParams = { unitId: 'E1', status: 'OUT_OF_SERVICE' };
  mockApiRequest.mockRejectedValueOnce(
    new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' }),
  );
  await render(<ServiceStatusScreen />);

  await press(screen.getByRole('button', { name: 'Return E1 to service' }));
  await press(screen.getByRole('button', { name: 'Yes, return it to service' }));
  expect(await screen.findByText(/Nothing was changed/)).toBeTruthy();
});
