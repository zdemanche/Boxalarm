import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { mockMeRepository } from './mockMeRepository';
import type { LosapTotal, MemberProfile, MeRepository, Qualification } from './types';

/** Prefers the real personnel-service member endpoints when online + authenticated + API base
 * configured; falls back to the local mock otherwise - same pattern as useChecksRepository. */
export function useMeRepository(): MeRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const memberId = auth?.memberId ?? null;
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<MeRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated || !memberId) {
      return mockMeRepository;
    }

    return {
      ...mockMeRepository,

      async getProfile(): Promise<MemberProfile> {
        const tokens = authRef.current;
        if (!tokens) return mockMeRepository.getProfile();
        const response = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}`,
          tokens,
          { apiBaseUrl },
        );
        return (await response.json()) as MemberProfile;
      },

      async updateProfile(update): Promise<MemberProfile> {
        const tokens = authRef.current;
        if (!tokens) return mockMeRepository.updateProfile(update);
        const currentResponse = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}`,
          tokens,
          { apiBaseUrl },
        );
        const current = (await currentResponse.json()) as MemberProfile;
        await apiRequest(`personnel/members/${encodeURIComponent(memberId)}`, tokens, {
          apiBaseUrl,
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        });
        return { ...current, ...update };
      },

      async getQualifications(): Promise<Qualification[]> {
        const tokens = authRef.current;
        if (!tokens) return mockMeRepository.getQualifications();
        const response = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}/quals`,
          tokens,
          { apiBaseUrl },
        );
        return (await response.json()) as Qualification[];
      },

      async getLosapTotal(): Promise<LosapTotal> {
        const tokens = authRef.current;
        if (!tokens) return mockMeRepository.getLosapTotal();
        const response = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}/losap`,
          tokens,
          { apiBaseUrl },
        );
        return (await response.json()) as LosapTotal;
      },
    };
  }, [apiBaseUrl, isAuthenticated, memberId]);
}
