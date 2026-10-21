import { render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
import { MyEquipmentScreen } from './MyEquipmentScreen';
import { MyPpeScreen } from './MyPpeScreen';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({
  useOptionalAuth: jest.fn(),
  useAuth: () => ({ memberId: 'MBR-0001' }),
}));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));

const mockApiRequest = apiRequest as jest.Mock;

const mockAuthValue: AuthContextValue = {
  roles: ['MEMBER'],
  memberId: 'MBR-0001',
  isAuthenticated: true,
  isLoading: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('access-token'),
  renewSilently: jest.fn().mockResolvedValue('access-token'),
};

beforeEach(() => {
  mockApiRequest.mockReset();
  (useOptionalAuth as jest.Mock).mockReturnValue(mockAuthValue);
});

test('a network failure shows a retryable error, never mock PPE', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Network request failed'));

  const { findByRole, queryByText } = await render(<MyPpeScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toMatch(/could not be loaded/);
  expect(queryByText(/turnout_coat/)).toBeNull();
  expect(queryByText('No PPE issued to you.')).toBeNull();
});

test('a 503 shows an error instead of the empty PPE state', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503, traceId: 't' }),
  );

  const { findByRole, queryByText } = await render(<MyPpeScreen />);

  await findByRole('alert');
  expect(queryByText('No PPE issued to you.')).toBeNull();
});

test('a 403 shows an access error and never mock equipment', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, traceId: 't' }),
  );

  const { findByRole, queryByText } = await render(<MyEquipmentScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe('You do not have access to your equipment.');
  expect(queryByText('THERM-0092')).toBeNull();
  expect(queryByText('No equipment assigned to you.')).toBeNull();
});
