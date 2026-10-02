import { describe, expect, it, vi } from 'vitest';
import { CACHE_TTL_MS, createRevocationChecker, revocationFailsOpen } from './revocationCheck.js';

const MEMBER = { deptId: 'NICHOLS', sub: 'sub-1' };

describe('createRevocationChecker', () => {
  it('revokes a token issued at or before revokedAt and allows one issued after', async () => {
    const checker = createRevocationChecker(() => Promise.resolve(1_000));

    await expect(checker.check({ ...MEMBER, issuedAt: 999 })).resolves.toBe('revoked');
    await expect(checker.check({ ...MEMBER, issuedAt: 1_000 })).resolves.toBe('revoked');
    await expect(checker.check({ ...MEMBER, issuedAt: 1_001 })).resolves.toBe('allow');
  });

  it('allows when the member was never revoked', async () => {
    const checker = createRevocationChecker(() => Promise.resolve(undefined));

    await expect(checker.check({ ...MEMBER, issuedAt: 1 })).resolves.toBe('allow');
  });

  it('caches per member for CACHE_TTL_MS, then reads again', async () => {
    let now = 0;
    const read = vi.fn().mockResolvedValue(undefined);
    const checker = createRevocationChecker(read, () => now);

    await checker.check({ ...MEMBER, issuedAt: 1 });
    now = CACHE_TTL_MS - 1;
    await checker.check({ ...MEMBER, issuedAt: 1 });
    expect(read).toHaveBeenCalledTimes(1);

    now = CACHE_TTL_MS;
    read.mockResolvedValue(5);
    await expect(checker.check({ ...MEMBER, issuedAt: 1 })).resolves.toBe('revoked');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by department and member', async () => {
    const read = vi.fn((_deptId: string, sub: string) =>
      Promise.resolve(sub === 'sub-1' ? 10 : undefined),
    );
    const checker = createRevocationChecker(read);

    await expect(checker.check({ ...MEMBER, issuedAt: 5 })).resolves.toBe('revoked');
    await expect(checker.check({ deptId: 'NICHOLS', sub: 'sub-2', issuedAt: 5 })).resolves.toBe(
      'allow',
    );
  });

  it('answers unavailable when the store fails with nothing cached', async () => {
    const checker = createRevocationChecker(() => Promise.reject(new Error('down')));

    await expect(checker.check({ ...MEMBER, issuedAt: 1 })).resolves.toBe('unavailable');
  });

  it('falls back to a stale cached answer when the store fails', async () => {
    let now = 0;
    const read = vi.fn().mockResolvedValueOnce(10).mockRejectedValue(new Error('down'));
    const checker = createRevocationChecker(read, () => now);

    await checker.check({ ...MEMBER, issuedAt: 5 });
    now = CACHE_TTL_MS * 10;

    await expect(checker.check({ ...MEMBER, issuedAt: 5 })).resolves.toBe('revoked');
  });
});

// Review of fix/access-control, MAJOR 1: an LOB-table blip must never 403 the alerting plane.
describe('revocationFailsOpen', () => {
  it.each([
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
  ])('fails open for the alerting-plane route %s on any authorizer', (routeKey) => {
    expect(revocationFailsOpen(routeKey, {})).toBe(true);
  });

  // The officer reads live under /api/v1/alerting/ but sit on the main authorizer BY
  // DESIGN (OFFICER_ALERTING_READ_ROUTES): a revoked token must not keep reading delivery
  // evidence during a platform-table outage. A path-prefix match used to force these open
  // (arch-amendments review M7).
  it.each([
    'GET /api/v1/alerting/dispatches/{dispatchId}/receipts',
    'GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics',
    'GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics/{memberId}',
    'GET /api/v1/alerting/audit',
    'GET /api/v1/alerting/canary/status',
    'GET /api/v1/alerting/delivery-baseline',
  ])('fails closed for the officer read route %s on the main authorizer', (routeKey) => {
    expect(revocationFailsOpen(routeKey, {})).toBe(false);
  });

  it.each([
    'GET /api/v1/personnel/members',
    'PUT /api/v1/personnel/members/{memberId}/status',
    'POST /api/v1/platform/export',
    'POST /api/v1/platform/sessions/revoke',
    'GET /api/v1/apparatus',
    'PUT /api/v1/incidents/{incidentId}/exposures',
  ])('fails closed for the LOB route %s on the main authorizer', (routeKey) => {
    expect(revocationFailsOpen(routeKey, {})).toBe(false);
  });

  it('fails open for every route when running as the alerting authorizer', () => {
    expect(
      revocationFailsOpen('GET /api/v1/alerting/anything-new', {
        REVOCATION_CHECK_FAIL_OPEN: 'true',
      }),
    ).toBe(true);
    expect(revocationFailsOpen('GET /x', { REVOCATION_CHECK_FAIL_OPEN: 'true' })).toBe(true);
  });
});
