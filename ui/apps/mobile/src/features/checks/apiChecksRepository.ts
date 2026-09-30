import { useMemo, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { apiRequest } from '../../lib/apiClient';
import { memberCacheKey } from '../../sync/memberCache';
import { readThrough } from '../../sync/readThrough';
import * as syncManager from '../../sync/syncManager';
import { mockChecksRepository } from './mockChecksRepository';
import type {
  Apparatus,
  ChecklistRunSubmission,
  ChecklistTemplate,
  ChecksRepository,
  DefectSubmission,
  OpenDefect,
} from './types';

/** ChecksRepository plus a way for callers to know the last getApparatus() call was served from
 * this phone's cache of the last real response, and how old it is (undefined on the mock repo). */
export type ChecksRepositoryWithFallbackFlag = ChecksRepository & {
  /** Epoch ms of the cached apparatus list the last getApparatus() returned; null when live. */
  apparatusCachedAt?: () => number | null;
};

function unitPath(unitId: string, suffix: string): string {
  return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;
}

/**
 * Prefers GET /api/v1/apparatus when authenticated + API base is configured. The local mock is
 * used only when no API is configured or nobody is signed in (pre-infra dev builds, navigation
 * unit tests) - never as an offline stand-in for real data (see readThrough).
 *
 * The returned object is memoized (useMemo keyed on the primitives that actually change its
 * behavior) so callers can safely put it in a useEffect dependency array: a screen re-render
 * that doesn't change apiBaseUrl/isAuthenticated returns the *same* repository reference,
 * instead of a new object literal every render (which previously caused an unconditional
 * fetch -> setState -> re-render -> new repository -> fetch... loop for any authenticated user
 * with API_BASE_URL configured).
 */
export function useChecksRepository(): ChecksRepositoryWithFallbackFlag {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;

  // Read via a ref inside the memoized methods so a token-source refresh (e.g. a role/state
  // change that doesn't flip isAuthenticated) is still picked up without recomputing the
  // memoized object on every render.
  const authRef = useRef(auth);
  authRef.current = auth;

  return useMemo<ChecksRepositoryWithFallbackFlag>(() => {
    if (!apiBaseUrl || !isAuthenticated) {
      return mockChecksRepository;
    }

    let lastApparatusCachedAt: number | null = null;
    // Cache keys carry the member, so a phone handed to another member never shows the previous
    // member's cached data as theirs.
    const cacheKey = (suffix: string) => {
      const memberId = authRef.current?.memberId;
      return memberId ? memberCacheKey.read(memberId, suffix) : null;
    };

    return {
      ...mockChecksRepository,
      // Offline (the apparatus bay is the designed-for case) this serves the last real list this
      // phone fetched, flagged with its time - never the mock fixtures, which are not this
      // department's apparatus. With nothing cached it throws NoCachedDataError.
      async getApparatus(): Promise<Apparatus[]> {
        const tokens = authRef.current;
        if (!tokens) return mockChecksRepository.getApparatus();
        const result = await readThrough(cacheKey('apparatus'), 'the apparatus list', async () => {
          const response = await apiRequest('apparatus', tokens, { apiBaseUrl });
          const body = (await response.json()) as { apparatus: Apparatus[] };
          return body.apparatus;
        });
        lastApparatusCachedAt = result.cachedAt;
        return result.value;
      },
      apparatusCachedAt(): number | null {
        return lastApparatusCachedAt;
      },

      async getChecklistTemplate(unitId: string): Promise<ChecklistTemplate> {
        const tokens = authRef.current;
        if (!tokens) return mockChecksRepository.getChecklistTemplate(unitId);
        const result = await readThrough(
          cacheKey(`checklist:${unitId}`),
          `the check sheet for ${unitId}`,
          async () => {
            const response = await apiRequest(unitPath(unitId, 'checklist'), tokens, {
              apiBaseUrl,
            });
            return (await response.json()) as ChecklistTemplate;
          },
        );
        return result.cachedAt === null
          ? result.value
          : { ...result.value, cachedAt: result.cachedAt };
      },

      async getOpenDefects(unitId: string): Promise<OpenDefect[]> {
        const tokens = authRef.current;
        if (!tokens) return [];
        const response = await apiRequest(`apparatus/${encodeURIComponent(unitId)}`, tokens, {
          apiBaseUrl,
        });
        const body = (await response.json()) as { openDefects?: OpenDefect[] };
        return body.openDefects ?? [];
      },

      async submitChecklistRun(run: ChecklistRunSubmission): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockChecksRepository.submitChecklistRun(run);
        await syncManager.enqueueChecklistRun(run.apparatusId, run.idempotencyKey, {
          templateId: run.templateId,
          completedBy: tokens.memberId ?? undefined,
          completedAt: Math.floor(Date.now() / 1000),
          durationSeconds: run.durationSeconds,
          itemResults: run.itemResults,
          idempotencyKey: run.idempotencyKey,
          capturedOffline: run.capturedOffline ?? false,
        });
      },

      async submitDefect(defect: DefectSubmission): Promise<void> {
        const tokens = authRef.current;
        if (!tokens) return mockChecksRepository.submitDefect(defect);
        await syncManager.enqueueDefect(
          defect.apparatusId,
          defect.idempotencyKey,
          {
            description: defect.description,
            severity: defect.severity,
            idempotencyKey: defect.idempotencyKey,
            ...(defect.photoFileName ? { photo: { filename: defect.photoFileName } } : {}),
          },
          defect.photoLocalUri,
        );
      },
    };
  }, [apiBaseUrl, isAuthenticated]);
}
