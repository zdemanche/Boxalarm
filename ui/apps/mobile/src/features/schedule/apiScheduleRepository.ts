import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { memberCacheKey } from '../../sync/memberCache';
import { readThrough } from '../../sync/readThrough';
import * as syncManager from '../../sync/syncManager';
import { mockScheduleRepository } from './mockScheduleRepository';
import {
  ClaimNeedsConnectionError,
  MarkOffBeingSentError,
  MarkOffNeedsConnectionError,
  NotSignedInError,
  type ClaimResult,
  type DutyShift,
  type MarkOff,
  type MarkUnavailableResult,
  type ScheduleRepository,
} from './types';

/**
 * Prefers the real personnel-service endpoints (architecture.md personnel-service §Interfaces)
 * when authenticated + API base configured. The local mock is used only with no API configured
 * or nobody signed in (pre-infra dev builds, navigation unit tests). Offline, getShifts serves
 * the last real list this phone fetched (flagged via shiftsCachedAt) - never mock shifts - and
 * claimPosition refuses rather than inventing a result.
 *
 * getShifts() reads GET /shifts (list metadata only - no positions per the personnel-service
 * fact sheet); positions is always empty on that read. Position-level claim state comes from
 * getShift(shiftId) - GET /shifts/{shiftId} (handleGetShift) - which ShiftDetailScreen calls
 * once it knows which shift it is showing, so the list screen never pays for data it doesn't
 * render.
 */
export function useScheduleRepository(): ScheduleRepository {
  const auth = useOptionalAuth();
  const { isOnline } = useOptionalConnectivity();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<ScheduleRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated) {
      return mockScheduleRepository;
    }

    let lastShiftsCachedAt: number | null = null;

    return {
      async getShifts(): Promise<DutyShift[]> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.getShifts();
        const result = await readThrough(
          tokens.memberId ? memberCacheKey.read(tokens.memberId, 'shifts') : null,
          'the shift list',
          async () => {
            const response = await apiRequest('personnel/shifts', tokens, { apiBaseUrl });
            const body = (await response.json()) as {
              shifts: Array<Omit<DutyShift, 'positions'>>;
            };
            return body.shifts.map((shift) => ({ ...shift, positions: [] }));
          },
        );
        lastShiftsCachedAt = result.cachedAt;
        return result.value;
      },

      shiftsCachedAt(): number | null {
        return lastShiftsCachedAt;
      },

      async getShift(shiftId): Promise<DutyShift> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.getShift(shiftId);
        const result = await readThrough(
          tokens.memberId ? memberCacheKey.read(tokens.memberId, `shift:${shiftId}`) : null,
          'this shift',
          async () => {
            const response = await apiRequest(
              `personnel/shifts/${encodeURIComponent(shiftId)}`,
              tokens,
              { apiBaseUrl },
            );
            const body = (await response.json()) as Omit<DutyShift, 'positions'> & {
              positions: Array<{
                positionCode: string;
                requiredQual?: string;
                claimedByMemberId?: string;
                claimedByMe?: boolean;
              }>;
            };
            return {
              ...body,
              positions: body.positions.map((position) => ({
                positionCode: position.positionCode,
                requiredQual: position.requiredQual ?? null,
                claimedByMemberId: position.claimedByMemberId ?? null,
                ...(position.claimedByMe !== undefined
                  ? { claimedByMe: position.claimedByMe }
                  : {}),
              })),
            };
          },
        );
        return result.value;
      },

      async claimPosition(shiftId, positionCode, idempotencyKey): Promise<ClaimResult> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.claimPosition(shiftId, positionCode);
        // A made-up claim result offline told a volunteer they held a shift the server never
        // saw. Claims are atomic server-side (F2.9): refuse, and let the screen say so.
        if (!isOnline) throw new ClaimNeedsConnectionError();
        try {
          const response = await apiRequest(
            `personnel/shifts/${encodeURIComponent(shiftId)}/claim`,
            tokens,
            {
              apiBaseUrl,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                positionCode,
                // Reuse the caller-supplied key (generated once per claim intent) when given, so
                // a reconnect retry of the same intent carries the same idempotency key. Only a
                // caller with no retry concept (or a direct one-off call) falls back to
                // generating one here.
                idempotencyKey: idempotencyKey ?? `${shiftId}#${positionCode}#${Date.now()}`,
              }),
            },
          );
          // The backend's claimShiftPosition.ts distinguishes a fresh CLAIMED from an idempotent
          // ALREADY_MINE (this member already holds it) - both are 2xx successes, structurally
          // identical apart from `kind`, never a thrown ApiError. Read the outcome off the body
          // when the (not-yet-wired) endpoint sends one; default to CLAIMED for a bare 2xx with
          // no body so today's minimal contract still behaves as before.
          let outcome: 'CLAIMED' | 'ALREADY_MINE' = 'CLAIMED';
          try {
            const body = (await response.json()) as { outcome?: string };
            if (body?.outcome === 'ALREADY_MINE') outcome = 'ALREADY_MINE';
          } catch {
            // No/invalid JSON body - treat as a fresh claim.
          }
          return outcome;
        } catch (error) {
          // 409 is the backend's CONFLICT outcome (problemDetails.ts conflictProblem) - someone
          // else holds the position. This is the only claim-failure status this codebase defines
          // for this route; a 412 check previously lived here too, but nothing anywhere in the
          // backend ever returns 412 for a shift claim, so it could never actually fire.
          if (error instanceof ApiError && error.problem.status === 409) {
            return 'ALREADY_TAKEN';
          }
          throw error;
        }
      },

      async releasePosition(shiftId, positionCode): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.releasePosition?.(shiftId, positionCode);
        await apiRequest(`personnel/shifts/${encodeURIComponent(shiftId)}/release`, tokens, {
          apiBaseUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positionCode }),
        });
      },

      async proposeSwap(shiftId, positionCode, toMemberId): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.proposeSwap?.(shiftId, positionCode, toMemberId);
        await apiRequest(`personnel/shifts/${encodeURIComponent(shiftId)}/swap`, tokens, {
          apiBaseUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positionCode, toMemberId }),
        });
      },

      async markUnavailable(startAt, endAt, reason): Promise<MarkUnavailableResult> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.markUnavailable(startAt, endAt, reason);
        const memberId = auth?.memberId;
        if (!memberId) throw new NotSignedInError();
        const startSeconds = Math.floor(new Date(startAt).getTime() / 1000);
        const endSeconds = Math.floor(new Date(endAt).getTime() / 1000);
        // The id covers the whole window, so a corrected mark-off is never collapsed into an
        // earlier one with the same start (review M1). An identical resubmit is the same id.
        const outboxId = `availability-${memberId}-${startSeconds}-${endSeconds}`;
        const { replaced, mayStand } = await syncManager.enqueueAvailability(
          outboxId,
          memberId,
          'Mark unavailable',
          {
            startAt: startSeconds,
            endAt: endSeconds,
            ...(reason ? { reason } : {}),
          },
        );
        return { outboxId, replacedUnsent: replaced, earlierMayStand: mayStand };
      },

      // Contract for the end-early API being added on the server branch (fix/post-merge-server,
      // not landed when this was written): GET .../availability lists current and upcoming
      // mark-offs as { markOffs: [{ markoffId?, startAt, endAt, reason? }] } in epoch seconds,
      // and POST .../availability/{markoffId}/end ends one now. The server keys a mark-off by its
      // start (MARKOFF#{startAt}), so a row without markoffId is addressed by its startAt.
      async listMarkOffs(): Promise<MarkOff[]> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.listMarkOffs!();
        const memberId = auth?.memberId;
        if (!memberId) throw new NotSignedInError();
        if (!isOnline) throw new MarkOffNeedsConnectionError();
        const response = await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}/availability`,
          tokens,
          { apiBaseUrl },
        );
        const body = (await response.json()) as {
          markOffs?: { markoffId?: string; startAt: number; endAt: number; reason?: string }[];
        };
        const now = Date.now() / 1000;
        return (body.markOffs ?? [])
          .filter((m) => m.endAt > now)
          .map((m) => ({
            markoffId: m.markoffId ?? String(m.startAt),
            startAt: m.startAt,
            endAt: m.endAt,
            ...(m.reason ? { reason: m.reason } : {}),
          }))
          .sort((a, b) => a.startAt - b.startAt);
      },

      async endMarkOff(markOff): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.endMarkOff!(markOff);
        const memberId = auth?.memberId;
        if (!memberId) throw new NotSignedInError();
        if (!isOnline) throw new MarkOffNeedsConnectionError();
        // A copy of this mark-off still waiting in the outbox would re-create it after it ends
        // (R3-M2): drop it first, or refuse while one is being sent.
        if ((await syncManager.neutraliseQueuedMarkOff(memberId, markOff.startAt)) === 'sending') {
          throw new MarkOffBeingSentError();
        }
        await apiRequest(
          `personnel/members/${encodeURIComponent(memberId)}/availability/${encodeURIComponent(markOff.markoffId)}/end`,
          tokens,
          { apiBaseUrl, method: 'POST' },
        );
      },
    };
  }, [apiBaseUrl, isAuthenticated, isOnline, auth?.memberId]);
}
