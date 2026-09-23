import { renderHook } from '@testing-library/react-native';
import { useEffect, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth, type AuthContextValue } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { useChecksRepository, type ChecksRepositoryWithFallbackFlag } from './apiChecksRepository';

// Mock factories are fully self-contained (no closures over outer consts): the module under
// test is imported statically above, which requires react-native-config/AuthContext/apiClient
// before any later top-level `const` in this file would have run, so a factory that closed
// over an outer mock variable would read it before initialization.
jest.mock('../../lib/apiClient', () => {
  const actual = jest.requireActual('../../lib/apiClient');
  return { ...actual, apiRequest: jest.fn() };
});
jest.mock('../../auth/AuthContext', () => ({ useOptionalAuth: jest.fn() }));
// jest.setup.js pins react-native-config's API_BASE_URL to '' globally so the API branch of
// useChecksRepository never runs under the default mock; this file needs it configured.
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

beforeEach(() => {
  mockApiRequest.mockReset();
  mockUseOptionalAuth.mockReturnValue(mockAuthValue);
  mockConfig.API_BASE_URL = 'https://api.example.com';
});

test('a re-render with unchanged inputs does not refire the fetch effect (regression for the infinite-loop bug)', async () => {
  mockApiRequest.mockResolvedValue({
    json: async () => ({ items: [] }),
  });

  // Mirrors ApparatusPickerScreen's own pattern: useChecksRepository() feeding a
  // useEffect(..., [repository]). Before the fix, useChecksRepository returned a brand-new
  // object every render, so this effect refired on every render, forever.
  function useProbe() {
    const repository = useChecksRepository();
    const effectRuns = useRef(0);
    useEffect(() => {
      effectRuns.current += 1;
      void repository.getApparatus();
    }, [repository]);
    return effectRuns;
  }

  const { result, rerender } = await renderHook(() => useProbe());

  expect(result.current.current).toBe(1);
  expect(mockApiRequest).toHaveBeenCalledTimes(1);

  // Re-render with identical inputs (isAuthenticated/apiBaseUrl unchanged).
  await rerender({});

  expect(result.current.current).toBe(1);
  expect(mockApiRequest).toHaveBeenCalledTimes(1);
});

test('network failure falls back to mock apparatus and flags the result as fallback data', async () => {
  mockApiRequest.mockRejectedValue(new TypeError('Failed to fetch'));

  const { result } = await renderHook(() => useChecksRepository());
  const repository = result.current as ChecksRepositoryWithFallbackFlag;

  const apparatus = await repository.getApparatus();

  expect(apparatus.length).toBeGreaterThan(0);
  expect(repository.isApparatusFallback?.()).toBe(true);
});

test('a 403 from the API surfaces as an error instead of silently falling back to mock data', async () => {
  const forbidden = new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: 'Cedar denied apparatus:list',
    traceId: 'trace-403',
  });
  mockApiRequest.mockRejectedValue(forbidden);

  const { result } = await renderHook(() => useChecksRepository());

  await expect(result.current.getApparatus()).rejects.toBe(forbidden);
});
