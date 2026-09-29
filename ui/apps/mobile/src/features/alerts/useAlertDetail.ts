import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ApiTimeoutError } from '../../lib/apiClient';
import {
  cachedAlertPayload,
  cachedDispatchDetail,
  rememberAlertPayload,
  rememberDispatchDetail,
  type AlertPayload,
} from './alertPayload';
import type { AlertsRepository, DispatchAlert } from './types';

/** Why the detail fetch failed - "unreachable" and "refused" need different words (N1 Error). */
export type DetailFailure = 'unreachable' | 'timeout' | 'server' | 'refused';

export function classifyDetailFailure(error: unknown): DetailFailure {
  if (error instanceof ApiTimeoutError) return 'timeout';
  if (error instanceof ApiError) {
    const { status } = error.problem;
    return status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'refused' : 'server';
  }
  return 'unreachable';
}

/** The fields the top of the alert screen needs, from whichever source has them. */
export interface AlertHeader {
  incidentType: string;
  address: string;
  crossStreets: string;
  toneSequence: number | null;
  /** Epoch ms, or null when neither the page nor the server said. */
  dispatchedAt: number | null;
}

export interface AlertDetailState {
  header: AlertHeader | null;
  detail: DispatchAlert | null;
  /** Epoch ms of a cached detail being shown because the live fetch has not succeeded. */
  detailCachedAt: number | null;
  status: 'loading' | 'loaded' | 'failed';
  failure: DetailFailure | null;
  retry: () => void;
}

/**
 * Never mixes calls: a payload or detail that belongs to another dispatch (a screen instance
 * reused for a second call, a late response for the previous one) is ignored, so the address
 * shown is always this call's.
 */
function headerFrom(
  dispatchId: string,
  pagePayload: AlertPayload | null,
  dispatchDetail: DispatchAlert | null,
): AlertHeader | null {
  const payload = pagePayload?.dispatchId === dispatchId ? pagePayload : null;
  const detail = dispatchDetail?.dispatchId === dispatchId ? dispatchDetail : null;
  if (!payload && !detail) return null;
  const address = detail?.address || payload?.address || '';
  return {
    incidentType: detail?.incidentType || payload?.incidentType || 'Dispatch',
    address,
    crossStreets: detail?.crossStreets || payload?.crossStreets || '',
    toneSequence: detail?.toneLadder?.currentToneSequence ?? payload?.toneSequence ?? null,
    dispatchedAt: payload?.receivedAt ?? (detail?.dispatchedAt ? detail.dispatchedAt * 1000 : null),
  };
}

/**
 * The alert screen's data: paint from the page payload (route param, else the on-device cache)
 * immediately, then hydrate from GET /dispatches/{id}. The fetch is bounded (repository timeout)
 * and a failure is a named, retryable state - the screen never waits blank on it.
 */
export function useAlertDetail(
  repository: AlertsRepository,
  dispatchId: string,
  routePayload: AlertPayload | undefined,
): AlertDetailState {
  const [payload, setPayload] = useState<AlertPayload | null>(routePayload ?? null);
  const [detail, setDetail] = useState<DispatchAlert | null>(null);
  const [detailCachedAt, setDetailCachedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<AlertDetailState['status']>('loading');
  const [failure, setFailure] = useState<DetailFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const liveLoadedRef = useRef(false);
  // Read through a ref: a caller that rebuilds the params object each render must not re-run
  // the cache reads (and their state updates) every render.
  const routePayloadRef = useRef(routePayload);
  routePayloadRef.current = routePayload;

  useEffect(() => {
    let cancelled = false;
    // A new call on the same screen instance: drop everything that belonged to the last one.
    liveLoadedRef.current = false;
    setDetail(null);
    setDetailCachedAt(null);
    const fromRoute =
      routePayloadRef.current?.dispatchId === dispatchId ? routePayloadRef.current : undefined;
    setPayload(fromRoute ?? null);
    if (fromRoute) {
      setPayload(fromRoute);
      void rememberAlertPayload(fromRoute);
    } else {
      void cachedAlertPayload(dispatchId).then((cached) => {
        if (!cancelled && cached) setPayload(cached);
      });
    }
    void cachedDispatchDetail(dispatchId).then((cached) => {
      if (cancelled || !cached || liveLoadedRef.current) return;
      if (cached.detail.dispatchId !== dispatchId) return;
      setDetail(cached.detail);
      setDetailCachedAt(cached.updatedAt);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchId]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFailure(null);
    repository.getDispatch(dispatchId).then(
      (result) => {
        if (cancelled) return;
        if (result.dispatchId !== dispatchId) {
          console.error('[alert] dispatch detail answered for another call; ignored', {
            asked: dispatchId,
            got: result.dispatchId,
          });
          setFailure('server');
          setStatus('failed');
          return;
        }
        liveLoadedRef.current = true;
        setDetail(result);
        setDetailCachedAt(null);
        setStatus('loaded');
        void rememberDispatchDetail(result);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn('[alert] loading dispatch detail failed', error);
        setFailure(classifyDetailFailure(error));
        setStatus('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatchId, repository, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    header: headerFrom(dispatchId, payload, detail),
    detail: detail?.dispatchId === dispatchId ? detail : null,
    detailCachedAt,
    status,
    failure,
    retry,
  };
}
