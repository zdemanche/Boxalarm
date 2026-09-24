import { render } from '@testing-library/react-native';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import type { Transcript } from '../../features/training/types';
import { TranscriptScreen, toCsv } from './TranscriptScreen';

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

test('renders certifications and hours by category from the API', async () => {
  mockApiRequest.mockImplementation(async (path: string) => {
    if (path === 'training/members/MBR-0001/transcript') {
      return {
        json: async () => ({
          memberId: 'MBR-0001',
          certifications: [
            { certId: 'CERT-1', certType: 'FF1', issuingAuthority: 'CT DESPP', expiryDate: '2027-01-01', status: 'CURRENT' },
          ],
          attendance: [],
          hoursByCategory: { Ladders: 4 },
        }),
      };
    }
    return { json: async () => ({}) };
  });

  const { findByText } = await render(<TranscriptScreen />);

  expect(await findByText('FF1 — CURRENT')).toBeTruthy();
  expect(await findByText('Ladders: 4h')).toBeTruthy();
});

test('shows an error message instead of hanging when the transcript fetch fails', async () => {
  mockApiRequest.mockRejectedValue(new Error('network error'));

  const { findByRole } = await render(<TranscriptScreen />);

  const alert = await findByRole('alert');
  expect(alert.props.children).toBe(
    'Transcript could not be loaded. Check your connection and try again.',
  );
});

describe('toCsv', () => {
  const baseTranscript: Transcript = {
    memberId: 'MBR-0001',
    certifications: [],
    attendance: [],
    hoursByCategory: {},
  };

  test('quotes a field containing a comma', () => {
    const csv = toCsv({
      ...baseTranscript,
      certifications: [
        {
          certId: 'CERT-1',
          certType: 'FF1, Recruit',
          issuingAuthority: 'CT DESPP',
          expiryDate: '2027-01-01',
          status: 'CURRENT',
        },
      ],
    });

    expect(csv).toContain('"FF1, Recruit",CURRENT,2027-01-01');
  });

  test('defuses a leading formula character in a user-entered field', () => {
    const csv = toCsv({
      ...baseTranscript,
      hoursByCategory: { '=SUM(A1:A9)': 3, '+cmd': 1, '-1+1': 2, '@evil': 4 },
    });

    expect(csv).toContain("'=SUM(A1:A9),3");
    expect(csv).toContain("'+cmd,1");
    expect(csv).toContain("'-1+1,2");
    expect(csv).toContain("'@evil,4");
  });

  test('leaves an ordinary field untouched', () => {
    const csv = toCsv({ ...baseTranscript, hoursByCategory: { Ladders: 4 } });

    expect(csv).toContain('Ladders,4');
  });
});
