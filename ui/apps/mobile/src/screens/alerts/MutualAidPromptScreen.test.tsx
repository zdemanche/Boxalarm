import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { MutualAid } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import { MutualAidPromptScreen } from './MutualAidPromptScreen';

jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
const mockLocked = { value: false as boolean | null };
const mockShowOverLock = jest.fn();
jest.mock('../../features/alerts/alertReadiness', () => ({
  isDeviceLocked: jest.fn(async () => mockLocked.value),
  setAlertShowsOverLockScreen: (show: boolean) => mockShowOverLock(show),
}));
const mockSilence = jest.fn<Promise<void>, [string]>(async () => undefined);
jest.mock('../../features/alerts/pushNotificationDisplay', () => ({
  silenceMutualAidNotification: (id: string) => mockSilence(id),
}));
jest.mock('../../features/alerts/apiAlertsRepository', () => ({ useAlertsRepository: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({
    params: {
      dispatchId: 'D-MA',
      payload: {
        dispatchId: 'D-MA',
        incidentType: 'Structure fire',
        address: '21 Main St',
        receivedAt: 1,
        mutualAidPrompt: true,
      },
    },
  }),
}));

const requested: MutualAid = {
  triggeredAt: 1_790_000_000,
  reason: 'AUTO',
  triggeredBy: null,
  acknowledgedBy: null,
  acknowledgedAt: null,
  notes: null,
};

let repository: { getDispatch: jest.Mock; acknowledgeMutualAid: jest.Mock };

beforeEach(() => {
  mockNavigate.mockClear();
  mockLocked.value = false;
  (AppState as { currentState: string }).currentState = 'active';
  mockShowOverLock.mockClear();
  mockSilence.mockClear();
  repository = {
    getDispatch: jest.fn(async () => ({
      dispatchId: 'D-MA',
      incidentType: 'Structure fire',
      address: '21 Main St',
      mutualAid: requested,
    })),
    acknowledgeMutualAid: jest.fn(async (_id: string, notes: string) => ({
      changed: true,
      mutualAid: {
        ...requested,
        acknowledgedBy: 'MBR-OFC',
        acknowledgedAt: 1_790_000_300,
        notes: notes || null,
      },
    })),
  };
  (useAlertsRepository as jest.Mock).mockReturnValue(repository);
  (useOptionalAuth as jest.Mock).mockReturnValue({ roles: ['OFFICER'], memberId: 'MBR-OFC' });
});

test('an officer sees the request and confirms the call, with notes', async () => {
  await render(<MutualAidPromptScreen />);

  expect(await screen.findByText('MUTUAL AID REQUESTED')).toBeTruthy();
  expect(screen.getByText('Structure fire — 21 Main St')).toBeTruthy();
  expect(await screen.findByText(/has not been confirmed yet/)).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText('Mutual-aid notes'), 'Spoke to Stratford');
  await fireEvent.press(screen.getByRole('button', { name: 'I made the mutual-aid call' }));

  expect(
    await screen.findByText(/Call confirmed at .* by MBR-OFC: Spoke to Stratford/),
  ).toBeTruthy();
  expect(repository.acknowledgeMutualAid).toHaveBeenCalledWith('D-MA', 'Spoke to Stratford');
  expect(screen.queryByRole('button', { name: 'I made the mutual-aid call' })).toBeNull();
});

test('another officer already confirmed it: says so, never silently', async () => {
  repository.acknowledgeMutualAid.mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      traceId: 't',
      detail: 'Mutual aid was already acknowledged by another officer. Your notes were not saved.',
    }),
  );
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/has not been confirmed yet/);

  await fireEvent.press(screen.getByRole('button', { name: 'I made the mutual-aid call' }));

  expect(await screen.findByText(/already acknowledged by another officer/)).toBeTruthy();
});

test('a member who is not an officer sees the request read-only', async () => {
  (useOptionalAuth as jest.Mock).mockReturnValue({ roles: ['MEMBER'], memberId: 'MBR-1' });
  await render(<MutualAidPromptScreen />);

  expect(await screen.findByText('Only an officer can confirm the call.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'I made the mutual-aid call' })).toBeNull();
});

test("Open the call goes to the call's alert screen, not the prompt", async () => {
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/has not been confirmed yet/);

  await fireEvent.press(screen.getByRole('button', { name: 'Open the call' }));

  const [route, params] = mockNavigate.mock.calls[0]!;
  expect(route).toBe('AlertDetail');
  expect(params.payload).not.toHaveProperty('mutualAidPrompt');
});

test('an admin can confirm the call too, as the server allows (N-m7)', async () => {
  (useOptionalAuth as jest.Mock).mockReturnValue({ roles: ['ADMIN'], memberId: 'MBR-ADM' });
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/has not been confirmed yet/);

  expect(screen.getByRole('button', { name: 'I made the mutual-aid call' })).toBeTruthy();
});

// N-m8: like a page, it stays over the lock screen and keeps ringing until acted on.
test('on a locked phone the prompt shows over the lock screen and keeps ringing; confirming needs an unlock', async () => {
  mockLocked.value = true;
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/has not been confirmed yet/);

  expect(mockShowOverLock).toHaveBeenCalledWith(true);
  expect(mockShowOverLock).not.toHaveBeenCalledWith(false);
  expect(mockSilence).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: 'I made the mutual-aid call' }));

  expect(mockSilence).toHaveBeenCalledWith('D-MA');
  expect(await screen.findByText('Unlock your phone to confirm the call.')).toBeTruthy();
  expect(repository.acknowledgeMutualAid).not.toHaveBeenCalled();
});

test('opened unlocked, it stops ringing at once; confirmed, it stops showing over the lock screen', async () => {
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/has not been confirmed yet/);
  expect(mockSilence).toHaveBeenCalledWith('D-MA');

  await fireEvent.press(screen.getByRole('button', { name: 'I made the mutual-aid call' }));
  await screen.findByText(/Call confirmed at/);

  expect(mockShowOverLock).toHaveBeenLastCalledWith(false);
});

test('Android: a lock state that cannot be read counts as locked for confirming', async () => {
  Platform.OS = 'android';
  mockLocked.value = null;
  try {
    await render(<MutualAidPromptScreen />);
    await screen.findByText(/has not been confirmed yet/);

    await fireEvent.press(screen.getByRole('button', { name: 'I made the mutual-aid call' }));

    expect(await screen.findByText('Unlock your phone to confirm the call.')).toBeTruthy();
    expect(repository.acknowledgeMutualAid).not.toHaveBeenCalled();
  } finally {
    Platform.OS = 'ios';
  }
});

test('already confirmed by another officer: it stops ringing and leaves the lock screen', async () => {
  mockLocked.value = true;
  repository.getDispatch.mockResolvedValueOnce({
    dispatchId: 'D-MA',
    incidentType: 'Structure fire',
    address: '21 Main St',
    mutualAid: { ...requested, acknowledgedBy: 'MBR-OTHER', acknowledgedAt: 1_790_000_100 },
  });
  await render(<MutualAidPromptScreen />);
  await screen.findByText(/Call confirmed at .* by MBR-OTHER/);

  expect(mockSilence).toHaveBeenCalledWith('D-MA');
  expect(mockShowOverLock).toHaveBeenLastCalledWith(false);
});
