import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { mockChecksRepository } from './mockChecksRepository';
import type { Apparatus, ChecksRepository } from './types';

/** ChecksRepository plus a way for callers to know the last getApparatus() call served
 * offline/fallback data instead of a real API response (undefined on the plain mock repo). */
export type ChecksRepositoryWithFallbackFlag = ChecksRepository & {
  isApparatusFallback?: () => boolean;
};

/**
 * Prefers GET /api/v1/apparatus when authenticated + API base is configured;
 * falls back to the local mock so Checks stays usable offline / pre-infra /
 * outside AuthProvider (navigation unit tests).
 *
 * The returned object is memoized (useMemo keyed on the primitives that actually change its
 * behavior) so callers can safely put it in a useEffect dependency array: a screen re-render
 * that doesn't change apiBaseUrl/isAuthenticated returns the *same* repository reference,
 * instead of a new object literal every render (which previously caused an unconditional
 * fetch -> setState -> re-render -> new repository -> fetch... loop for any authenticated user
 * with API_BASE_URL configured).
 */
export function useChecksRepository(): ChecksRepositoryWithFallbackFlag {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;

  // Read via a ref inside the memoized methods so a token-source refresh (e.g. a role/state
  // change that doesn't flip isAuthenticated) is still picked up without recomputing the
  // memoized object on every render.
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<ChecksRepositoryWithFallbackFlag>(() => {
    if (!apiBaseUrl || !isAuthenticated) {
      return mockChecksRepository;
    }

    let lastGetApparatusWasFallback = false;

    return {
      ...mockChecksRepository,
      async getApparatus(): Promise<Apparatus[]> {
        const tokens = authRef.current;
        if (!tokens) {
          lastGetApparatusWasFallback = true;
          return mockChecksRepository.getApparatus();
        }

        try {
          const response = await apiRequest('apparatus', tokens, { apiBaseUrl });
          const body = (await response.json()) as { items: Apparatus[] };
          lastGetApparatusWasFallback = false;
          return body.items;
        } catch (error) {
          if (error instanceof ApiError) {
            // Auth (401/403) and server (5xx) errors are real signal — e.g. a revoked member
            // or a stale token must not be masked by fake apparatus data in a safety-critical
            // truck-check flow. Surface it to the caller instead of silently substituting mocks.
            throw error;
          }
          // Genuine network/offline failure (e.g. TypeError: Failed to fetch): fall back to
          // the local mock so Checks stays usable, and flag it so the caller can show an
          // "offline data" indicator rather than presenting it as a real fetch.
          lastGetApparatusWasFallback = true;
          return mockChecksRepository.getApparatus();
        }
      },
      isApparatusFallback(): boolean {
        return lastGetApparatusWasFallback;
      },
    };
  }, [apiBaseUrl, isAuthenticated]);
}
