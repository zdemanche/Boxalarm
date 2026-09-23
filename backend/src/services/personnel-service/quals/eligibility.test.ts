import { describe, expect, it } from 'vitest';
import { deriveCurrentlyEligible } from './eligibility.js';

describe('deriveCurrentlyEligible', () => {
  it('is eligible when the qual is not backed by a certification (AC1)', () => {
    expect(deriveCurrentlyEligible(null)).toBe(true);
  });

  it('is ineligible when the granting certification has expired (AC2)', () => {
    expect(deriveCurrentlyEligible('CERT-0091', 'EXPIRED')).toBe(false);
  });

  it('is eligible when the granting certification is current', () => {
    expect(deriveCurrentlyEligible('CERT-0091', 'CURRENT')).toBe(true);
  });

  it('is ineligible when the granting certification is revoked', () => {
    expect(deriveCurrentlyEligible('CERT-0091', 'REVOKED')).toBe(false);
  });

  it('fail-secure defaults a cert-backed qual to ineligible when cert status is not yet known', () => {
    expect(deriveCurrentlyEligible('CERT-0091')).toBe(false);
  });
});
