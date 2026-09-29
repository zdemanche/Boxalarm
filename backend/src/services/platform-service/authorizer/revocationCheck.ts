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
 *  - Otherwise every ALERTING-PLANE route FAILS OPEN: responding and the roster, but also
 *    manual dispatch (the N1.8 degraded-mode path), tone-ladder advance/halt, mutual aid,
 *    the riding board, push-token registration and the alerting ops reads. None of them
 *    reads the platform table; the revocation store is the only thing coupling them to it,
 *    and "an outage in reporting, training or inventory must never degrade alert delivery"
 *    (backend/CLAUDE.md). The residual - a revoked token keeps using the alerting plane for
 *    the length of a platform-table outage - is bounded by the token's own 1-hour life, is
 *    what happened before this check existed, and alarms (RevocationCheckFailOpen).
 *  - Every other (LOB) route FAILS CLOSED (403): those routes read and write the platform
 *    and LOB tables themselves, so a store outage has already taken them down.
 * An alerting-plane route is recognised two ways, either being enough: the alerting
 * authorizer Lambda runs with REVOCATION_CHECK_FAIL_OPEN=true (every route it serves is
 * alerting-plane - infrastructure/components/api/http-api.ts ALERTING_PLANE_ROUTES), and
 * the route key itself matches ALERTING_PLANE_ROUTE_PATTERNS, so a route wired to the main
 * authorizer by mistake still fails open.
 */
export const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

export const ALERTING_PLANE_ROUTE_PATTERNS: readonly RegExp[] = [
  /^[A-Z]+ \/api\/v1\/alerting\//,
  /^[A-Z]+ \/api\/v1\/apparatus\/riding-board\//,
  /^[A-Z]+ \/api\/v1\/personnel\/members\/\{memberId\}\/push-tokens$/,
];

export function revocationFailsOpen(routeKey: string, env: NodeJS.ProcessEnv): boolean {
  return (
    env.REVOCATION_CHECK_FAIL_OPEN === 'true' ||
    ALERTING_PLANE_ROUTE_PATTERNS.some((pattern) => pattern.test(routeKey))
  );
}

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
