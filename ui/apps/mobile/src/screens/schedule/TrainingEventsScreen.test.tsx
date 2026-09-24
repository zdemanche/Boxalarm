import { fireEvent, render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { TrainingEventsScreen } from './TrainingEventsScreen';

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

test('signing up for a training event marks it signed up', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'training/events') {
      return {
        json: async () => [
          {
            eventId: 'evt-1',
            title: 'Ladder drill',
            category: 'Ladders',
            startAt: 1,
            endAt: 2,
            signedUp: false,
          },
        ],
      };
    }
    return { json: async () => ({}) };
  });

  const { findByText } = await render(<TrainingEventsScreen />);

  const row = await findByText('Ladder drill');
  fireEvent.press(row);

  expect(await findByText('Signed up')).toBeTruthy();
  expect(mockApiRequest).toHaveBeenCalledWith(
    'training/events/evt-1/signup',
    mockAuthValue,
    expect.objectContaining({ method: 'POST' }),
  );
});

test('shows an error message instead of hanging when the events fetch fails', async () => {
  mockApiRequest.mockRejectedValue(new Error('network error'));

  const { findByRole } = await render(<TrainingEventsScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Training events could not be loaded. Check your connection and try again.',
  );
});
