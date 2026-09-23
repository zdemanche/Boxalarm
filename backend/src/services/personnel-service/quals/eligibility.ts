export type CertStatus = 'CURRENT' | 'EXPIRED' | 'REVOKED';

export function deriveCurrentlyEligible(
  grantedByCertId: string | null,
  certStatus?: CertStatus,
): boolean {
  if (grantedByCertId === null) {
    return true;
  }
  return certStatus === 'CURRENT';
}
