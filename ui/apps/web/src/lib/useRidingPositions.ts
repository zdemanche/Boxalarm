import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { getConfig } from '../features/platform/api';

export interface RidingPosition {
  code: string;
  label: string;
  requiredQual?: string;
}

/**
 * The department's riding positions from its RIDING_POSITIONS config (platform-service config,
 * keyed by apparatus type; GET is open to every signed-in role), merged into one list by code -
 * the first definition of a code wins. Empty while loading, when none are set up (404), or when
 * the read fails: callers then fall back to a typed code.
 */
export function useRidingPositions(): { positions: RidingPosition[]; isLoading: boolean } {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['platform', 'config', 'RIDING_POSITIONS'],
    queryFn: () => getConfig(auth, 'RIDING_POSITIONS'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const byCode = new Map<string, RidingPosition>();
  for (const list of Object.values(query.data?.value ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const raw of list as Record<string, unknown>[]) {
      if (typeof raw?.code !== 'string' || typeof raw.label !== 'string' || byCode.has(raw.code)) {
        continue;
      }
      byCode.set(raw.code, {
        code: raw.code,
        label: raw.label,
        ...(typeof raw.requiredQual === 'string' ? { requiredQual: raw.requiredQual } : {}),
      });
    }
  }
  return { positions: [...byCode.values()], isLoading: query.isLoading };
}
