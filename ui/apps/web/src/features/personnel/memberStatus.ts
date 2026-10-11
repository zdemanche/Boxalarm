import type { StatusRole } from '@boxalarm/design-tokens';
import type { MemberStatus } from './types';

/** The chip colour for each member status; the word is always `humanize(status)`. */
export const MEMBER_STATUS_ROLE: Record<MemberStatus, StatusRole> = {
  ACTIVE: 'ok',
  PROBATIONARY: 'info',
  LOA: 'warning',
  RETIRED: 'neutral',
};
