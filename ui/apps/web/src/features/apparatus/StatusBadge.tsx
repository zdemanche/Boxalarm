import type { StatusRole } from '@boxalarm/design-tokens';

export function serviceStatusRole(status: 'IN_SERVICE' | 'OUT_OF_SERVICE'): StatusRole {
  return status === 'IN_SERVICE' ? 'ok' : 'danger';
}
