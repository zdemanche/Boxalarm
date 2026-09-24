import { useMemo } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { mockInventoryRepository } from './mockInventoryRepository';
import type { EquipmentAsset, InventoryRepository, PpeAssignment } from './types';

/** Prefers the real inventory-service endpoints when authenticated + API base is configured;
 * falls back to the local mock otherwise (pre-infra, offline, or outside AuthProvider). Mirrors
 * ChecksStack's useChecksRepository pattern (see apiChecksRepository.ts). */
export function useInventoryRepository(): InventoryRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;

  return useMemo<InventoryRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated || !auth) {
      return mockInventoryRepository;
    }

    return {
      async getMyEquipment(memberId: string): Promise<EquipmentAsset[]> {
        try {
          const response = await apiRequest(
            `inventory/equipment?assignedToType=MEMBER&assignedToId=${encodeURIComponent(memberId)}`,
            auth,
            { apiBaseUrl },
          );
          const body = (await response.json()) as { items: EquipmentAsset[] };
          return body.items;
        } catch (error) {
          if (error instanceof ApiError) throw error;
          return mockInventoryRepository.getMyEquipment(memberId);
        }
      },

      async getMyPpe(memberId: string): Promise<PpeAssignment[]> {
        try {
          const response = await apiRequest(`inventory/ppe/${encodeURIComponent(memberId)}`, auth, {
            apiBaseUrl,
          });
          return (await response.json()) as PpeAssignment[];
        } catch (error) {
          if (error instanceof ApiError) throw error;
          return mockInventoryRepository.getMyPpe(memberId);
        }
      },
    };
  }, [apiBaseUrl, isAuthenticated, auth]);
}
