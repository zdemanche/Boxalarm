import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest, ApiError } from '../../lib/apiClient';
import { mockAttendanceRepository } from './mockAttendanceRepository';
import type { AttendanceRecord, AttendanceRepository } from './types';

/** Prefers POST/GET /api/v1/personnel/attendance when online + authenticated + API base
 * configured; falls back to the local mock otherwise - same pattern as useChecksRepository.
 * `occurredAt` is the DynamoDB sort key on this entity (attendance/handler.ts), so a resubmit of
 * the same record is inherently idempotent server-side: a 409 here means it already posted, not
 * a failure. */
export function useAttendanceRepository(): AttendanceRepository {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<AttendanceRepository>(() => {
    if (!apiBaseUrl || !isAuthenticated) {
      return mockAttendanceRepository;
    }

    return {
      async getOwnRecords(): Promise<AttendanceRecord[]> {
        const tokens = authRef.current;
        if (!tokens) return mockAttendanceRepository.getOwnRecords();
        try {
          const response = await apiRequest('personnel/attendance', tokens, { apiBaseUrl });
          const body = (await response.json()) as { records: AttendanceRecord[] };
          return body.records;
        } catch (error) {
          // Auth (401/403) and server (5xx) errors are real signal - a revoked member or a
          // stale token must not be masked by fake attendance data. Only a genuine
          // network/offline failure (e.g. TypeError: Failed to fetch) falls back to the mock,
          // matching useChecksRepository's precedent and this file's own record() method.
          if (error instanceof ApiError) throw error;
          return mockAttendanceRepository.getOwnRecords();
        }
      },

      async record(entry): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockAttendanceRepository.record(entry);
        try {
          await apiRequest('personnel/attendance', tokens, {
            apiBaseUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry),
          });
        } catch (error) {
          if (error instanceof ApiError && error.problem.status === 409) return;
          throw error;
        }
      },
    };
  }, [apiBaseUrl, isAuthenticated]);
}
