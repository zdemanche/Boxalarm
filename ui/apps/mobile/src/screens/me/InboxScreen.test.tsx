import { fireEvent, render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { InboxScreen } from './InboxScreen';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;

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
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
});

test('opening an unread notification marks it read', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'notifications') {
      return {
        json: async () => ({
          items: [
            {
              notificationId: 'n-1',
              category: 'CERT_EXPIRY',
              summary: '1 item expiring',
              createdAt: 1,
              readAt: null,
            },
          ],
        }),
      };
    }
    return { json: async () => ({}) };
  });

  const { findByText } = await render(<InboxScreen />);

  const row = await findByText('1 item expiring');
  fireEvent.press(row);

  expect(mockApiRequest).toHaveBeenCalledWith(
    'notifications/n-1/read',
    mockAuthValue,
    expect.objectContaining({ method: 'POST' }),
  );
});
