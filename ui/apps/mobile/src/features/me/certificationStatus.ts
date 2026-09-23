import type { PaletteColors } from '@boxalarm/design-tokens';

export type CertificationStatus = 'CURRENT' | 'EXPIRED' | 'REVOKED';

export function certificationStatusColor(
  status: CertificationStatus,
  tokens: PaletteColors,
): string {
  return status === 'CURRENT' ? tokens.success : tokens.error;
}

const LABEL: Record<CertificationStatus, string> = {
  CURRENT: 'Current',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export function certificationStatusLabel(status: CertificationStatus): string {
  return LABEL[status];
}
