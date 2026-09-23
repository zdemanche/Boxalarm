import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { useInventoryRepository } from './apiInventoryRepository';

jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
const mockConfig = Config as unknown as { API_BASE_URL: string };

const mockAuthValue: AuthContextValue = {
  roles: ['MEMBER'],
  memberId: 'MBR-1',
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
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('fetches My PPE from the real endpoint when authenticated and configured (E4-S12-UI AC4)', async () => {
  mockApiRequest.mockResolvedValue({
    json: async () => [
      {
        ppeItemId: 'coat',
        itemType: 'turnout_coat',
        size: 'L',
        issueDate: '2020-01-01',
        nfpaExpiryDate: '2030-01-01',
        status: 'ISSUED',
      },
    ],
  });

  const { result } = await renderHook(() => useInventoryRepository());
  const ppe = await result.current.getMyPpe('MBR-1');

  expect(mockApiRequest).toHaveBeenCalledWith('inventory/ppe/MBR-1', mockAuthValue, {
    apiBaseUrl: 'https://api.example.com',
  });
  expect(ppe[0]?.ppeItemId).toBe('coat');
});

test('network failure falls back to mock equipment', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Failed to fetch'));

  const { result } = await renderHook(() => useInventoryRepository());
  const equipment = await result.current.getMyEquipment('MBR-1');

  expect(equipment.length).toBeGreaterThan(0);
});

test('a 403 surfaces as an error instead of silently falling back', async () => {
  const forbidden = new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    traceId: 'trace-403',
  });
  mockApiRequest.mockRejectedValue(forbidden);

  const { result } = await renderHook(() => useInventoryRepository());

  await expect(result.current.getMyPpe('MBR-1')).rejects.toBe(forbidden);
});
