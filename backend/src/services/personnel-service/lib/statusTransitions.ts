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

/**
 * The one status -> paging mapping (decision 2026-09-29, review round 2 item (a)). Probationary
 * members are working members - they respond, usually riding with restrictions - so they are
 * paged and keep their devices, as every member is from creation (createMember makes them
 * PROBATIONARY and the snapshot seeds them active). Only LOA and RETIRED stop paging, clear push
 * devices and end sessions: the same set as platform session revocation's REVOKING_STATUSES.
 */
export const NON_PAGED_STATUSES: ReadonlySet<string> = new Set(['LOA', 'RETIRED']);

/** Whether a member in `status` is paged (alerting snapshot `active`). */
export function isPagedStatus(status: string): boolean {
  return !NON_PAGED_STATUSES.has(status);
}
