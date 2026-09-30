import { fireEvent, render, screen } from '@testing-library/react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { MutualAid } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import { MutualAidPromptScreen } from './MutualAidPromptScreen';

jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
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
