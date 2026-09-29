import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { kvGet, kvSet } from '../../sync/kvStore';
import { recentPages } from './alertPayload';
import { classifyDetailFailure, type DetailFailure } from './useAlertDetail';
import type { ActiveDispatchList, ActiveDispatchSummary, AlertsRepository } from './types';

const CACHE_KEY = 'active-dispatches';
/** Pages received on this phone are offered as calls for this long when the list is unreachable. */
export const RECENT_PAGE_WINDOW_MS = 2 * 60 * 60_000;
export const ACTIVE_LIST_REFRESH_MS = 30_000;

export interface ActiveCall extends ActiveDispatchSummary {
  /** True for a page this phone received that the (unreachable) server list could not confirm. */
  fromPageOnly: boolean;
}

export interface ActiveDispatchesState {
  calls: ActiveCall[];
  /** 'live' = the server answered on the last try; 'cached' = showing the last good list. */
  source: 'live' | 'cached' | 'none';
  /** Epoch ms the shown list was fetched (live or cached). */
  updatedAt: number | null;
  truncated: boolean;
  loading: boolean;
  refreshing: boolean;
  failure: DetailFailure | null;
  refresh: () => Promise<void>;
}

async function withRecentPages(calls: ActiveDispatchSummary[], now: number): Promise<ActiveCall[]> {
  const known = new Set(calls.map((c) => c.dispatchId));
  const pages = (await recentPages()).filter(
    (page) => !known.has(page.dispatchId) && now - page.receivedAt <= RECENT_PAGE_WINDOW_MS,
  );
  return [
    ...calls.map((c) => ({ ...c, fromPageOnly: false })),
    ...pages.map((page) => ({
      dispatchId: page.dispatchId,
      incidentType: page.incidentType,
      address: page.address || null,
      crossStreets: page.crossStreets ?? null,
      dispatchedAt: Math.floor(page.receivedAt / 1000),
      toneSequence: page.toneSequence ?? 1,
      fromPageOnly: true,
    })),
  ].sort((a, b) => b.dispatchedAt - a.dispatchedAt);
}

/**
 * The Alerts tab's list: GET alerting/dispatches?status=active, refreshed on open, every 30 s,
 * on return to the foreground and on pull. The last good list is kept on the phone and shown,
 * stamped with its time, whenever the server cannot be reached - never a blank list during a
 * call (design.md F-02/F-05 offline). Offline, pages this phone received recently are added.
 */
export function useActiveDispatches(repository: AlertsRepository): ActiveDispatchesState {
  const [calls, setCalls] = useState<ActiveCall[]>([]);
  const [source, setSource] = useState<ActiveDispatchesState['source']>('none');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<DetailFailure | null>(null);
  const mountedRef = useRef(true);
  // Set once any load has settled: the first-paint cache read must never overwrite its result.
  const settledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await repository.listActiveDispatches();
      if (!mountedRef.current) return;
      settledRef.current = true;
      const now = Date.now();
      setCalls(list.dispatches.map((d) => ({ ...d, fromPageOnly: false })));
      setSource('live');
      setUpdatedAt(now);
      setTruncated(list.truncated);
      setFailure(null);
      await kvSet<ActiveDispatchList>(CACHE_KEY, list, now);
    } catch (error) {
      if (!mountedRef.current) return;
      console.warn('[alerts] loading the active call list failed', error);
      setFailure(classifyDetailFailure(error));
      const cached = await kvGet<ActiveDispatchList>(CACHE_KEY);
      const merged = await withRecentPages(cached?.value.dispatches ?? [], Date.now());
      if (!mountedRef.current) return;
      settledRef.current = true;
      setCalls(merged);
      setSource(cached ? 'cached' : 'none');
      setUpdatedAt(cached?.updatedAt ?? null);
      setTruncated(cached?.value.truncated ?? false);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [repository]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (mountedRef.current) setRefreshing(false);
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    // Paint the last good list at once; the live answer replaces it.
    void kvGet<ActiveDispatchList>(CACHE_KEY).then((cached) => {
      if (!cached || !mountedRef.current || settledRef.current) return;
      setCalls(cached.value.dispatches.map((d) => ({ ...d, fromPageOnly: false })));
      setSource('cached');
      setUpdatedAt(cached.updatedAt);
    });
    void load();
    const timer = setInterval(() => void load(), ACTIVE_LIST_REFRESH_MS);
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void load();
    });
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [load]);

  return { calls, source, updatedAt, truncated, loading, refreshing, failure, refresh };
}
