import { fireEvent, render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { ApiError, apiRequest } from '../../lib/apiClient';
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
            startAt: Date.now() + 3_600_000,
            endAt: Date.now() + 7_200_000,
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

function mockEvents(signup: () => Promise<unknown>, startAt = Date.now() + 3_600_000) {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'training/events') {
      return {
        json: async () => [
          {
            eventId: 'evt-1',
            title: 'Ladder drill',
            category: 'Ladders',
            startAt,
            endAt: startAt + 1,
            signedUp: false,
          },
        ],
      };
    }
    return signup();
  });
}

test('a 422 on sign-up says the event has started and does not mark it signed up', async () => {
  mockEvents(async () => {
    throw new ApiError({ type: 'about:blank', title: 'Unprocessable', status: 422, traceId: 't' });
  });

  const { findByText, findByRole, queryByText } = await render(<TrainingEventsScreen />);
  fireEvent.press(await findByText('Ladder drill'));

  expect((await findByRole('alert')).props.children).toBe(
    'Sign-up is closed: this event has started.',
  );
  expect(queryByText('Signed up')).toBeNull();
});

test('a failed sign-up with no signal shows a retryable error', async () => {
  mockEvents(async () => {
    throw new TypeError('Network request failed');
  });

  const { findByText, findByRole } = await render(<TrainingEventsScreen />);
  fireEvent.press(await findByText('Ladder drill'));

  expect((await findByRole('alert')).props.children).toMatch(/Could not sign you up/);
});

test('a 409 means already signed up', async () => {
  mockEvents(async () => {
    throw new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, traceId: 't' });
  });

  const { findByText } = await render(<TrainingEventsScreen />);
  fireEvent.press(await findByText('Ladder drill'));

  expect(await findByText('Signed up')).toBeTruthy();
});

test('an event that has started offers no sign-up', async () => {
  mockEvents(async () => ({ json: async () => ({}) }), Date.now() - 3_600_000);

  const { findByText, queryByText } = await render(<TrainingEventsScreen />);
  fireEvent.press(await findByText('Ladder drill'));

  expect(await findByText('Sign-up closed')).toBeTruthy();
  expect(queryByText('Sign up')).toBeNull();
  expect(mockApiRequest).toHaveBeenCalledTimes(1);
});

test('repeated taps while a sign-up is in flight send one POST', async () => {
  let release: () => void = () => {};
  mockEvents(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ json: async () => ({}) });
      }),
  );

  const { findByText } = await render(<TrainingEventsScreen />);
  const row = await findByText('Ladder drill');
  await fireEvent.press(row);
  await fireEvent.press(row);
  release();

  expect(await findByText('Signed up')).toBeTruthy();
  expect(mockApiRequest).toHaveBeenCalledTimes(2);
});
