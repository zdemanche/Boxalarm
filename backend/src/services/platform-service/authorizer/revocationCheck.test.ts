import { describe, expect, it, vi } from 'vitest';
import { CACHE_TTL_MS, createRevocationChecker, FAIL_OPEN_ROUTE_KEYS } from './revocationCheck.js';

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

describe('FAIL_OPEN_ROUTE_KEYS', () => {
  it('is only the responder read/respond path - never dispatch creation or an admin route', () => {
    expect([...FAIL_OPEN_ROUTE_KEYS].sort()).toEqual([
      'GET /api/v1/alerting/dispatches',
      'GET /api/v1/alerting/dispatches/{dispatchId}',
      'GET /api/v1/alerting/dispatches/{dispatchId}/roster',
      'POST /api/v1/alerting/dispatches/{dispatchId}/responses',
    ]);
  });
});
