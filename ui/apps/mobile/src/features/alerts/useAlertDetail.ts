import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ApiTimeoutError } from '../../lib/apiClient';
import {
  cachedAlertPayload,
  cachedDispatchDetail,
  rememberAlertPayload,
  mergePayload,
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
  /**
   * When: the server's dispatch time when known, else when this phone received the page -
   * labelled as such, so an old call tapped late never reads "just now" as its dispatch time.
   */
  time: { at: number; kind: 'dispatched' | 'received' } | null;
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

function latestTone(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined) return b ?? null;
  if (b === undefined) return a;
  return Math.max(a, b);
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
  payloadIsNewer: boolean,
): AlertHeader | null {
  const payload = pagePayload?.dispatchId === dispatchId ? pagePayload : null;
  const detail = dispatchDetail?.dispatchId === dispatchId ? dispatchDetail : null;
  if (!payload && !detail) return null;
  const address =
    (payloadIsNewer ? payload?.address || detail?.address : detail?.address || payload?.address) ||
    '';
  return {
    incidentType: detail?.incidentType || payload?.incidentType || 'Dispatch',
    address,
    crossStreets: detail?.crossStreets || payload?.crossStreets || '',
    toneSequence: latestTone(payload?.toneSequence, detail?.toneLadder?.currentToneSequence),
    time: detail?.dispatchedAt
      ? { at: detail.dispatchedAt * 1000, kind: 'dispatched' }
      : payload?.dispatchedAt
        ? { at: payload.dispatchedAt, kind: 'dispatched' }
        : payload
          ? { at: payload.receivedAt, kind: 'received' }
          : null,
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
  const [payloadIsNewer, setPayloadIsNewer] = useState(false);
  const liveLoadedRef = useRef(false);
  // Read through a ref: a caller that rebuilds the params object each render must not re-run
  // the cache reads (and their state updates) every render.
  const routePayloadRef = useRef(routePayload);
  routePayloadRef.current = routePayload;
  const routeKey =
    routePayload?.dispatchId === dispatchId
      ? `${dispatchId}#${routePayload.receivedAt}#${routePayload.toneSequence ?? ''}#${routePayload.address}`
      : null;
  const routeKeyRef = useRef(routeKey);
  routeKeyRef.current = routeKey;
  const appliedRouteKeyRef = useRef(routeKey);
  const latestRouteReceivedAtRef = useRef(
    routePayload?.dispatchId === dispatchId ? routePayload.receivedAt : 0,
  );

  useEffect(() => {
    let cancelled = false;
    // A new call on the same screen instance: drop everything that belonged to the last one.
    liveLoadedRef.current = false;
    appliedRouteKeyRef.current = routeKeyRef.current;
    latestRouteReceivedAtRef.current =
      routePayloadRef.current?.dispatchId === dispatchId ? routePayloadRef.current.receivedAt : 0;
    setPayloadIsNewer(false);
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
    if (routeKey === appliedRouteKeyRef.current) return;
    appliedRouteKeyRef.current = routeKey;
    const next = routePayloadRef.current;
    if (!next || next.dispatchId !== dispatchId) return;
    if (next.receivedAt <= latestRouteReceivedAtRef.current) {
      setAttempt((n) => n + 1);
      return;
    }
    latestRouteReceivedAtRef.current = next.receivedAt;
    setPayload((current) =>
      mergePayload(current?.dispatchId === dispatchId ? current : null, next),
    );
    setPayloadIsNewer(true);
    void rememberAlertPayload(next);
    setAttempt((n) => n + 1);
  }, [routeKey, dispatchId]);

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
        setPayloadIsNewer(false);
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
    header: headerFrom(dispatchId, payload, detail, payloadIsNewer),
    detail: detail?.dispatchId === dispatchId ? detail : null,
    detailCachedAt,
    status,
    failure,
    retry,
  };
}
