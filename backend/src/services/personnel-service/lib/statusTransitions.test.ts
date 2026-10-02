import { describe, expect, it } from 'vitest';
import {
  isPagedStatus,
  isReinstatement,
  isValidStatusTransition,
  MEMBER_STATUSES as ALL_STATUSES,
} from './statusTransitions.js';

describe('isValidStatusTransition', () => {
  it.each([
    ['PROBATIONARY', 'ACTIVE'],
    ['PROBATIONARY', 'LOA'],
    ['PROBATIONARY', 'RETIRED'],
    ['ACTIVE', 'LOA'],
    ['LOA', 'ACTIVE'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidStatusTransition(from, to)).toBe(true);
  });

  it('rejects a same-status no-op transition', () => {
    expect(isValidStatusTransition('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('leaves RETIRED only by reinstatement to ACTIVE (post-merge MAJOR-2)', () => {
    expect(isValidStatusTransition('RETIRED', 'ACTIVE')).toBe(true);
    expect(isReinstatement('RETIRED', 'ACTIVE')).toBe(true);
    expect(isValidStatusTransition('RETIRED', 'LOA')).toBe(false);
    expect(isValidStatusTransition('RETIRED', 'RETIRED')).toBe(false);
    expect(isReinstatement('LOA', 'ACTIVE')).toBe(false);
  });
});

describe('status -> paging (decision 2026-09-29, round 2 item a)', () => {
  it('pages ACTIVE and PROBATIONARY members; LOA and RETIRED are not paged', () => {
    expect(ALL_STATUSES.filter(isPagedStatus)).toEqual(['ACTIVE', 'PROBATIONARY']);
  });

  it('stops paging for exactly the statuses session revocation signs out', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL(
        '../../platform-service/session-revocation/memberStatusRevocationHandler.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const revoking = /REVOKING_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
    const revokingStatuses = [...(revoking ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(revokingStatuses.sort()).toEqual(
      ALL_STATUSES.filter((status) => !isPagedStatus(status)).sort(),
    );
  });
});
