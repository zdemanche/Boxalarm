import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest, type ApiRequestOptions, type AuthTokenSource } from '../../lib/apiClient';
import { etaFor, queueAlertResponse } from './alertResponses';
import { mockAlertsRepository } from './mockAlertsRepository';
import type {
  ActiveDispatchList,
  AlertsRepository,
  DeliveryReceipt,
  DispatchAlert,
  ManualDispatchInput,
  RidingBoard,
  RosterEntry,
  SelfTestRun,
  HomeLocality,
  MutualAid,
  ToneLadderStatus,
} from './types';

/** The alert screen already shows the page's own text; enrichment that has not arrived by now is
 * replaced by a retryable "couldn't load" rather than an open-ended spinner (a11y-spec N1). */
export const ALERT_DETAIL_TIMEOUT_MS = 8_000;

function buildApiAlertsRepository(tokens: AuthTokenSource, apiBaseUrl: string): AlertsRepository {
  const req = (path: string, init?: Omit<ApiRequestOptions, 'apiBaseUrl'>) =>
    apiRequest(path, tokens, { ...init, apiBaseUrl });

  return {
    async triggerSelfTest() {
      const response = await req('alerting/self-test', { method: 'POST' });
      const body = (await response.json()) as { testId: string; dispatchId: string };
      return { testId: body.testId, dispatchId: body.dispatchId };
    },

    async getSelfTestRun(testId): Promise<SelfTestRun> {
      const response = await req(`alerting/self-test/${encodeURIComponent(testId)}`);
      return (await response.json()) as SelfTestRun;
    },

    async getDispatch(dispatchId): Promise<DispatchAlert> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}`, {
        timeoutMs: ALERT_DETAIL_TIMEOUT_MS,
      });
      const body = (await response.json()) as {
        dispatchId: string;
        incidentType: string;
        address: string;
        crossStreets: string;
        mapLink: string | null;
        narrative: string;
        fanOutStartedAt?: number | null;
        toneLadder?: {
          status: ToneLadderStatus;
          currentToneSequence: number;
          nextToneAt: string | number | null;
        };
        prePlan: DispatchAlert['prePlan'];
        prePlanUnavailable?: boolean;
        nearestHydrants?: DispatchAlert['nearestHydrants'];
        nearestHydrantsUnavailable?: boolean;
        nearestHydrantsIncomplete?: boolean;
        mutualAid?: MutualAid | null;
      };
      return {
        dispatchId: body.dispatchId,
        incidentType: body.incidentType,
        address: body.address,
        crossStreets: body.crossStreets,
        mapLink: body.mapLink,
        narrative: body.narrative,
        isSelfTest: false,
        ...(typeof body.fanOutStartedAt === 'number' ? { dispatchedAt: body.fanOutStartedAt } : {}),
        // Previously dropped: the tone number is part of the alert header ("TONE 2").
        ...(body.toneLadder
          ? {
              toneLadder: {
                status: body.toneLadder.status,
                currentToneSequence: body.toneLadder.currentToneSequence,
                nextToneAt:
                  typeof body.toneLadder.nextToneAt === 'number'
                    ? new Date(body.toneLadder.nextToneAt * 1000).toISOString()
                    : body.toneLadder.nextToneAt,
                predicateGaps: [],
              },
            }
          : {}),
        prePlan: body.prePlan,
        ...(body.prePlanUnavailable === true ? { prePlanUnavailable: true } : {}),
        ...(body.nearestHydrants ? { nearestHydrants: body.nearestHydrants } : {}),
        ...(body.nearestHydrantsUnavailable === true ? { nearestHydrantsUnavailable: true } : {}),
        ...(body.nearestHydrantsIncomplete === true ? { nearestHydrantsIncomplete: true } : {}),
        ...(body.mutualAid !== undefined ? { mutualAid: body.mutualAid } : {}),
      };
    },

    async acknowledgeMutualAid(dispatchId, notes) {
      const response = await req(
        `alerting/dispatches/${encodeURIComponent(dispatchId)}/mutual-aid/acknowledge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notes.trim() ? { notes: notes.trim() } : {}),
        },
      );
      const body = (await response.json()) as { changed: boolean; mutualAid: MutualAid };
      return { changed: body.changed, mutualAid: body.mutualAid };
    },

    async listActiveDispatches(): Promise<ActiveDispatchList> {
      const response = await req('alerting/dispatches?status=active', {
        timeoutMs: ALERT_DETAIL_TIMEOUT_MS,
      });
      const body = (await response.json()) as {
        dispatches: {
          dispatchId: string;
          incidentType: string | null;
          address: string | null;
          crossStreets: string | null;
          dispatchedAt: number;
          toneLadder?: { currentToneSequence?: number };
        }[];
        asOf: number;
        truncated?: boolean;
      };
      return {
        dispatches: body.dispatches.map((d) => ({
          dispatchId: d.dispatchId,
          incidentType: d.incidentType,
          address: d.address,
          crossStreets: d.crossStreets,
          dispatchedAt: d.dispatchedAt,
          toneSequence: d.toneLadder?.currentToneSequence ?? 1,
        })),
        asOf: body.asOf,
        truncated: body.truncated === true,
      };
    },

    async getRoster(dispatchId): Promise<RosterEntry[]> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}/roster`);
      const body = (await response.json()) as { members: RosterEntry[] };
      return body.members;
    },

    // Through the SQLite outbox, never a bare POST: the old `void submitResponse` dropped a failed
    // answer on the floor while the screen said "You responded" (alert-ux C2).
    async submitResponse(dispatchId, ackStatus, eta) {
      const outboxId = await queueAlertResponse(dispatchId, ackStatus, etaFor(ackStatus, eta));
      return { outboxId };
    },

    async submitManualDispatch(input: ManualDispatchInput) {
      const response = await req('alerting/dispatches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as { dispatchId: string };
      return { dispatchId: body.dispatchId };
    },

    async getHomeLocality(): Promise<HomeLocality> {
      const response = await req('alerting/home-locality');
      return (await response.json()) as HomeLocality;
    },

    async getReceipts(dispatchId): Promise<DeliveryReceipt[]> {
      const response = await req(`alerting/dispatches/${encodeURIComponent(dispatchId)}/receipts`);
      const body = (await response.json()) as { receipts: DeliveryReceipt[] };
      return body.receipts;
    },

    async getRidingBoard(dispatchId): Promise<RidingBoard> {
      const response = await req(`apparatus/riding-board/${encodeURIComponent(dispatchId)}`);
      return (await response.json()) as RidingBoard;
    },

    async assignRidingSeat(dispatchId, seat) {
      await req(`apparatus/riding-board/${encodeURIComponent(dispatchId)}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unitId: seat.unitId,
          positionCode: seat.positionCode,
          memberId: seat.memberId,
          expectedVersion: seat.expectedVersion,
          clientAssignmentId: `${dispatchId}-${seat.unitId}-${seat.positionCode}-${Date.now()}`,
        }),
      });
    },
  };
}

/**
 * Prefers the real alerting-service/apparatus-service API when authenticated + API base is
 * configured; falls back to the local mock so the Alerts stack stays usable offline / pre-infra /
 * outside AuthProvider (navigation unit tests) - same pattern as useChecksRepository.
 */
export function useAlertsRepository(): AlertsRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;

  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<AlertsRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated || !authRef.current) {
      return mockAlertsRepository;
    }
    return buildApiAlertsRepository(authRef.current, apiBaseUrl);
  }, [apiBaseUrl, isAuthenticated]);
}
