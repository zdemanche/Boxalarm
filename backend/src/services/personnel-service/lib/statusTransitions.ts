export const MEMBER_STATUSES = ['ACTIVE', 'PROBATIONARY', 'LOA', 'RETIRED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const SETTABLE_STATUSES = ['ACTIVE', 'LOA', 'RETIRED'] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export function isValidStatusTransition(from: MemberStatus, to: SettableStatus): boolean {
  if (from === 'RETIRED') {
    return false;
  }
  return from !== to;
}
