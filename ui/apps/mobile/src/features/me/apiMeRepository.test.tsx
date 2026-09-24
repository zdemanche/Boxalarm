import { renderHook } from '@testing-library/react-native';
import Config from 'react-native-config';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { useMeRepository } from './apiMeRepository';
import { mockMeRepository } from './mockMeRepository';
import type { MemberProfile } from './types';

// Mock factories are fully self-contained (no closures over outer consts), matching
// apiChecksRepository.test.tsx's precedent.
jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
// jest.setup.js pins react-native-config's API_BASE_URL to '' globally so the API branch of
// useMeRepository never runs under the default mock; this file needs it configured.
jest.mock('react-native-config', () => ({ __esModule: true, default: { API_BASE_URL: '' } }));

const mockApiRequest = apiRequest as jest.Mock;
const mockUseOptionalAuth = useOptionalAuth as jest.Mock;
const mockConfig = Config as unknown as { API_BASE_URL: string };

const mockAuthValue: AuthContextValue = {
  roles: ['MEMBER'],
  memberId: 'MBR-0012',
  isAuthenticated: true,
  isLoading: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('access-token'),
  renewSilently: jest.fn().mockResolvedValue('access-token'),
};

const PROFILE: MemberProfile = {
  memberId: 'MBR-0012',
  firstName: 'Jamie',
  lastName: 'Rios',
  rank: 'Firefighter',
  email: 'jrios@example.org',
  phone: '(203) 555-0142',
};

beforeEach(() => {
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('getProfile returns the real profile on a successful call', async () => {
  mockApiRequest.mockResolvedValue({ json: async () => PROFILE });

  const { result } = await renderHook(() => useMeRepository());

  await expect(result.current.getProfile()).resolves.toEqual(PROFILE);
});

test('updateProfile merges onto the cached getProfile() result without a redundant GET', async () => {
  mockApiRequest
    .mockResolvedValueOnce({ json: async () => PROFILE }) // getProfile()
    .mockResolvedValueOnce({
      json: async () => ({ memberId: PROFILE.memberId, updatedAt: 1, phone: '(203) 555-9999' }),
    }); // the PUT

  const { result } = await renderHook(() => useMeRepository());

  await result.current.getProfile();
  mockApiRequest.mockClear();
  mockApiRequest.mockResolvedValueOnce({
    json: async () => ({ memberId: PROFILE.memberId, updatedAt: 1, phone: '(203) 555-9999' }),
  });

  const updated = await result.current.updateProfile({ phone: '(203) 555-9999' });

  // Only the PUT fired - no GET before it, since getProfile() already cached a base to merge onto.
  expect(mockApiRequest).toHaveBeenCalledTimes(1);
  expect(mockApiRequest.mock.calls[0]?.[2]).toMatchObject({ method: 'PUT' });
  expect(updated).toEqual({ ...PROFILE, phone: '(203) 555-9999' });
});

test('updateProfile falls back to one GET when called before this repository has ever fetched a profile', async () => {
  mockApiRequest
    .mockResolvedValueOnce({ json: async () => PROFILE }) // fallback GET
    .mockResolvedValueOnce({
      json: async () => ({ memberId: PROFILE.memberId, updatedAt: 1, firstName: 'Jordan' }),
    }); // the PUT

  const { result } = await renderHook(() => useMeRepository());

  const updated = await result.current.updateProfile({ firstName: 'Jordan' });

  expect(mockApiRequest).toHaveBeenCalledTimes(2);
  expect(updated).toEqual({ ...PROFILE, firstName: 'Jordan' });
});

test('falls back to the mock repository when unauthenticated', async () => {
  mockUseOptionalAuth.mockReturnValue(undefined);

  const { result } = await renderHook(() => useMeRepository());

  await expect(result.current.getProfile()).resolves.toEqual(await mockMeRepository.getProfile());
  expect(mockApiRequest).not.toHaveBeenCalled();
});
