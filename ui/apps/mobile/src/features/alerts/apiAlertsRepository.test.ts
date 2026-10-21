import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { useAlertsRepository } from './apiAlertsRepository';

jest.mock('../../lib/apiClient', () => ({
  ...jest.requireActual('../../lib/apiClient'),
  apiRequest: jest.fn(),
}));
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({
  __esModule: true,
  default: { API_BASE_URL: 'https://api.example.com' },
}));

const mockApiRequest = apiRequest as jest.Mock;

beforeEach(() => {
  (Config as unknown as { API_BASE_URL: string }).API_BASE_URL = 'https://api.example.com';
  (useOptionalAuth as jest.Mock).mockReturnValue({
    isAuthenticated: true,
    memberId: 'MBR-1',
    getAccessToken: jest.fn(),
    renewSilently: jest.fn(),
  });
  mockApiRequest.mockReset();
});

async function rosterFor(members: unknown[]) {
  mockApiRequest.mockResolvedValue({ json: async () => ({ members }) });
  const { result } = await renderHook(() => useAlertsRepository());
  return result.current.getRoster('D-1');
}

describe('getRoster', () => {
  test('reads the server NONE (nobody has answered) as UNANSWERED', async () => {
    const roster = await rosterFor([
      { memberId: 'MBR-1', ackStatus: 'NONE', eta: null, quals: [] },
    ]);

    expect(roster.map((entry) => entry.ackStatus)).toEqual(['UNANSWERED']);
  });

  test('reads a missing or null status as UNANSWERED and fills quals and eta', async () => {
    const roster = await rosterFor([{ memberId: 'MBR-1' }, { memberId: 'MBR-2', ackStatus: null }]);

    expect(roster).toEqual([
      expect.objectContaining({ ackStatus: 'UNANSWERED', quals: [], eta: null }),
      expect.objectContaining({ ackStatus: 'UNANSWERED', quals: [], eta: null }),
    ]);
  });

  test('passes the three answers through unchanged', async () => {
    const roster = await rosterFor([
      { memberId: 'MBR-1', ackStatus: 'RESPONDING', eta: 1_800_000_000, quals: ['FF1'] },
      { memberId: 'MBR-2', ackStatus: 'NOT_RESPONDING' },
      { memberId: 'MBR-3', ackStatus: 'DIRECT_TO_SCENE' },
    ]);

    expect(roster.map((entry) => entry.ackStatus)).toEqual([
      'RESPONDING',
      'NOT_RESPONDING',
      'DIRECT_TO_SCENE',
    ]);
    expect(roster[0]).toMatchObject({ eta: 1_800_000_000, quals: ['FF1'] });
  });

  test('drops a row with a status it does not know rather than showing it as an answer', async () => {
    const roster = await rosterFor([
      { memberId: 'MBR-1', ackStatus: 'MAYBE' },
      { memberId: 'MBR-2', ackStatus: 'RESPONDING' },
    ]);

    expect(roster.map((entry) => entry.memberId)).toEqual(['MBR-2']);
  });
});
