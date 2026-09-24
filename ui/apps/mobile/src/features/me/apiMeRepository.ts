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

    // Cached from the last getProfile()/updateProfile() response so updateProfile can merge onto
    // a known-complete profile without firing a redundant GET first (see updateProfile below).
    let cachedProfile: MemberProfile | null = null;

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
        const profile = (await response.json()) as MemberProfile;
        cachedProfile = profile;
        return profile;
      },

      async updateProfile(update): Promise<MemberProfile> {
        const tokens = authRef.current;
        if (!tokens) return mockMeRepository.updateProfile(update);
        // personnel-service's updateMember.ts PUT handler echoes back only the fields it changed
        // (`{ memberId, updatedAt, ...updates }`), not the full member record, so this merges
        // onto the profile already cached from getProfile() instead of firing a GET first purely
        // to have something to merge onto - the PUT round trip alone is enough in the common case
        // (ProfileEditScreen always calls getProfile() before allowing a save). Only falls back
        // to a GET here if updateProfile() is somehow called before this repository has ever
        // fetched a profile.
        const base: MemberProfile =
          cachedProfile ??
          ((await (
            await apiRequest(`personnel/members/${encodeURIComponent(memberId)}`, tokens, {
              apiBaseUrl,
            })
          ).json()) as MemberProfile);
        const response = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}`,
          tokens,
          {
            apiBaseUrl,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update),
          },
        );
        const echoed = (await response.json()) as Partial<MemberProfile>;
        const merged: MemberProfile = { ...base, ...update, ...echoed };
        cachedProfile = merged;
        return merged;
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
