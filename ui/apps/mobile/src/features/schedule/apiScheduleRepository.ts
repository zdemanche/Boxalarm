import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { mockScheduleRepository } from './mockScheduleRepository';
import type { ClaimResult, DutyShift, ScheduleRepository } from './types';

/**
 * Prefers the real personnel-service endpoints (architecture.md personnel-service §Interfaces)
 * when online + authenticated + API base configured; falls back to the local mock otherwise, so
 * Schedule stays usable offline / pre-infra / outside AuthProvider (navigation unit tests) -
 * same pattern as useChecksRepository.
 *
 * getShifts() reads GET /shifts (list metadata only - no positions per the personnel-service
 * fact sheet). Position-level claim state has no member-facing read endpoint yet; positions is
 * left empty for real-backend shifts until that lands (ponytail: backend gap, upgrade path is
 * the E2-S8 backend ticket wiring a per-shift positions read).
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

    return {
      async getShifts(): Promise<DutyShift[]> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.getShifts();
        try {
          const response = await apiRequest('personnel/shifts', tokens, { apiBaseUrl });
          const body = (await response.json()) as {
            shifts: Array<Omit<DutyShift, 'positions'>>;
          };
          return body.shifts.map((shift) => ({ ...shift, positions: [] }));
        } catch (error) {
          if (error instanceof ApiError) throw error;
          return mockScheduleRepository.getShifts();
        }
      },

      async claimPosition(shiftId, positionCode): Promise<ClaimResult> {
        const tokens = authRef.current;
        if (!tokens || !isOnline) {
          return mockScheduleRepository.claimPosition(shiftId, positionCode);
        }
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
                idempotencyKey: `${shiftId}#${positionCode}#${Date.now()}`,
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

      async markUnavailable(startAt, endAt, reason): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockScheduleRepository.markUnavailable(startAt, endAt, reason);
        await apiRequest(
          `personnel/members/${encodeURIComponent(auth?.memberId ?? '')}/availability`,
          tokens,
          {
            apiBaseUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              startAt: Math.floor(new Date(startAt).getTime() / 1000),
              endAt: Math.floor(new Date(endAt).getTime() / 1000),
              ...(reason ? { reason } : {}),
            }),
          },
        );
      },
    };
  }, [apiBaseUrl, isAuthenticated, isOnline, auth?.memberId]);
}
