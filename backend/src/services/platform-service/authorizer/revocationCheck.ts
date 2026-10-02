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
 * the route key itself is in FAIL_OPEN_ROUTE_KEYS, so a route wired to the main
 * authorizer by mistake still fails open.
 *
 * FAIL_OPEN_ROUTE_KEYS lists exact route keys, never a path prefix: the officer read
 * routes (receipts, diagnostics, audit, canary status, delivery baseline) also live under
 * /api/v1/alerting/ but sit on the main authorizer BY DESIGN (http-api.ts
 * OFFICER_ALERTING_READ_ROUTES), so that during a platform-table outage a revoked token
 * cannot keep reading delivery evidence. A prefix match here used to force them open
 * anyway (arch-amendments review, M7). An infrastructure contract test pins this list to
 * ALERTING_PLANE_ROUTES so the two cannot drift.
 */
export const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

export const FAIL_OPEN_ROUTE_KEYS: readonly string[] = [
  'POST /api/v1/alerting/dispatches',
  'GET /api/v1/alerting/dispatches',
  'GET /api/v1/alerting/dispatches/{dispatchId}',
  'GET /api/v1/alerting/dispatches/{dispatchId}/roster',
  'POST /api/v1/alerting/dispatches/{dispatchId}/responses',
  'POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/advance',
  'POST /api/v1/alerting/dispatches/{dispatchId}/tone-ladder/halt',
  'POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/trigger',
  'POST /api/v1/alerting/dispatches/{dispatchId}/mutual-aid/acknowledge',
  'GET /api/v1/apparatus/riding-board/{dispatchId}',
  'POST /api/v1/apparatus/riding-board/{dispatchId}/assignments',
  'POST /api/v1/personnel/members/{memberId}/push-tokens',
  'DELETE /api/v1/personnel/members/{memberId}/push-tokens',
  'GET /api/v1/alerting/home-locality',
  'POST /api/v1/alerting/devices/state',
  'POST /api/v1/alerting/self-test',
  'GET /api/v1/alerting/self-test/{testId}',
];

const FAIL_OPEN_ROUTE_KEY_SET: ReadonlySet<string> = new Set(FAIL_OPEN_ROUTE_KEYS);

export function revocationFailsOpen(routeKey: string, env: NodeJS.ProcessEnv): boolean {
  return env.REVOCATION_CHECK_FAIL_OPEN === 'true' || FAIL_OPEN_ROUTE_KEY_SET.has(routeKey);
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
