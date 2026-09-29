/**
 * Server-side session revocation check for the authorizer (review M1).
 *
 * Latency: at most one GetItem per member per CACHE_TTL_MS per warm authorizer instance, with
 * the store client's single-attempt 400 ms ceiling; everything else is a Map lookup. A
 * revocation therefore takes effect within CACHE_TTL_MS (plus the write), not the up-to-60
 * minutes an offline-verified access token would otherwise live.
 *
 * Store unavailable (throttle, timeout, outage) - the rule:
 *  - A stale cached answer for the member is used if there is one.
 *  - Otherwise the alerting read/respond routes below FAIL OPEN. Those are how a responder
 *    sees the call and says they are coming; the revocation store is platform-table data
 *    they do not otherwise depend on, and "a login prompt on the alert path is an alerting
 *    failure" (CLAUDE.md). Failing closed would let an LOB-table outage stop a department
 *    answering a call. The residual risk - a revoked token keeps reading/answering a call
 *    for the length of the outage - is bounded by the token's own 1-hour life and was
 *    already the behaviour before this check existed.
 *  - Every other route FAILS CLOSED (403): they read/write the same platform/LOB tables, so
 *    an outage of the store has already taken them down, and failing closed costs nothing.
 */
export const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

/**
 * Route keys that fail open when the store cannot be read. Kept to the read/respond path a
 * responder uses during a call; manual dispatch, ladder controls and every admin route are
 * deliberately not here. Mirrored by infrastructure/components/api/http-api.ts
 * ALERTING_RESERVED_ROUTES (which reserves throttle capacity for these plus manual dispatch).
 */
export const FAIL_OPEN_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'GET /api/v1/alerting/dispatches',
  'GET /api/v1/alerting/dispatches/{dispatchId}',
  'GET /api/v1/alerting/dispatches/{dispatchId}/roster',
  'POST /api/v1/alerting/dispatches/{dispatchId}/responses',
]);

export type RevocationDecision = 'allow' | 'revoked' | 'unavailable';

export type RevokedAtReader = (deptId: string, sub: string) => Promise<number | undefined>;

interface CacheEntry {
  readonly revokedAt: number | undefined;
  readonly fetchedAtMs: number;
}

export interface RevocationChecker {
  check(input: { deptId: string; sub: string; issuedAt: number }): Promise<RevocationDecision>;
}

export function createRevocationChecker(
  readRevokedAt: RevokedAtReader,
  nowMs: () => number = Date.now,
): RevocationChecker {
  const cache = new Map<string, CacheEntry>();

  const decide = (revokedAt: number | undefined, issuedAt: number): RevocationDecision =>
    // <=: a token minted in the same second as the revocation is treated as pre-revocation.
    revokedAt !== undefined && issuedAt <= revokedAt ? 'revoked' : 'allow';

  return {
    async check({ deptId, sub, issuedAt }) {
      const key = `${deptId}#${sub}`;
      const cached = cache.get(key);
      if (cached && nowMs() - cached.fetchedAtMs < CACHE_TTL_MS) {
        return decide(cached.revokedAt, issuedAt);
      }
      try {
        const revokedAt = await readRevokedAt(deptId, sub);
        if (cache.size >= MAX_CACHE_ENTRIES) {
          cache.clear();
        }
        cache.set(key, { revokedAt, fetchedAtMs: nowMs() });
        return decide(revokedAt, issuedAt);
      } catch {
        return cached ? decide(cached.revokedAt, issuedAt) : 'unavailable';
      }
    },
  };
}
