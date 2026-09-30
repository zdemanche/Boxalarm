import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { getConfig } from '../features/platform/api';

export interface Station {
  stationId: string;
  name: string;
}

/**
 * The department's stations from its STATIONS config (platform-service config; GET is open to
 * every signed-in role). `stations` is empty while loading, when the department hasn't set any
 * up (404), or when the read fails - callers fall back to showing the raw id.
 */
export function useStations(): {
  stations: Station[];
  isLoading: boolean;
  nameFor: (stationId: string) => string;
} {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['platform', 'config', 'STATIONS'],
    queryFn: () => getConfig(auth, 'STATIONS'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const raw = (query.data?.value as { stations?: unknown } | undefined)?.stations;
  const stations = Array.isArray(raw)
    ? raw.filter(
        (s): s is Station =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as Station).stationId === 'string' &&
          typeof (s as Station).name === 'string',
      )
    : [];
  return {
    stations,
    isLoading: query.isLoading,
    nameFor: (stationId) => stations.find((s) => s.stationId === stationId)?.name ?? stationId,
  };
}
