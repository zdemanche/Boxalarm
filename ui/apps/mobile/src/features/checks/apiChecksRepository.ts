import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { mockChecksRepository } from './mockChecksRepository';
import type { Apparatus, ChecksRepository } from './types';

/**
 * Prefers GET /api/v1/apparatus when authenticated + API base is configured;
 * falls back to the local mock so Checks stays usable offline / pre-infra /
 * outside AuthProvider (navigation unit tests).
 */
export function useChecksRepository(): ChecksRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;

  if (!apiBaseUrl || !auth?.isAuthenticated) {
    return mockChecksRepository;
  }

  return {
    ...mockChecksRepository,
    async getApparatus(): Promise<Apparatus[]> {
      try {
        const response = await apiRequest('apparatus', auth, { apiBaseUrl });
        const body = (await response.json()) as { items: Apparatus[] };
        return body.items;
      } catch {
        return mockChecksRepository.getApparatus();
      }
    },
  };
}
