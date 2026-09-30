export type Role = 'MEMBER' | 'OFFICER' | 'TRAINING' | 'APPARATUS' | 'ADMIN' | 'CHIEF';

export const KNOWN_ROLES: readonly Role[] = [
  'MEMBER',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'ADMIN',
  'CHIEF',
];

function isRole(value: string): value is Role {
  return (KNOWN_ROLES as readonly string[]).includes(value);
}

/** Map Cognito ID-token claims → app roles. Backend authorizer uses `cognito:groups`. */
export function rolesFromProfile(profile: Record<string, unknown>): Role[] {
  const groups = profile['cognito:groups'];
  if (!Array.isArray(groups)) return ['MEMBER'];

  const roles = groups
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.toUpperCase())
    .filter(isRole);

  return roles.length > 0 ? roles : ['MEMBER'];
}

/** Training-record management (certifications, events, hours, transcripts): TRAINING or ADMIN.
 * One definition instead of per-file role checks (PR #321 review m10). */
export function canManageTraining(roles: readonly Role[]): boolean {
  return roles.includes('TRAINING') || roles.includes('ADMIN');
}

/** Officer review sign-off on an incident report (Cedar LockIncidentReport): OFFICER, CHIEF, ADMIN. */
export function canLockIncident(roles: readonly Role[]): boolean {
  return roles.includes('OFFICER') || roles.includes('CHIEF') || roles.includes('ADMIN');
}

/**
 * Sending a reviewed report to NERIS (Cedar SubmitIncidentReport, the NERIS officer tier):
 * OFFICER, CHIEF, ADMIN - the same officers who lock and resubmit it.
 */
export function canSubmitIncident(roles: readonly Role[]): boolean {
  return canLockIncident(roles);
}

/** Reopening a locked incident report (Cedar UnlockIncidentReport): CHIEF or ADMIN only. */
export function canUnlockIncident(roles: readonly Role[]): boolean {
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

/** Place a unit out of service / return it (Cedar UpdateServiceStatus, APPARATUS_OFFICER_GROUPS). */
export function canUpdateServiceStatus(roles: readonly Role[]): boolean {
  return (['APPARATUS', 'OFFICER', 'CHIEF', 'ADMIN'] as const).some((r) => roles.includes(r));
}

/** Register a new apparatus: apparatus-service createApparatus checks CHIEF/ADMIN
 * (authContext.ts ADMIN_GROUPS), not Cedar. */
export function canCreateApparatus(roles: readonly Role[]): boolean {
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

/**
 * Member status changes (LOA/RETIRED end every session and stop all paging): CHIEF or ADMIN on
 * the web. The API also admits OFFICER for ordinary members; the web leaves the most
 * destructive control to the chief (OQ-24) - and only CHIEF/ADMIN may reinstate a RETIRED
 * member or change a CHIEF/ADMIN's status.
 */
export function canChangeMemberStatus(roles: readonly Role[]): boolean {
  return roles.includes('CHIEF') || roles.includes('ADMIN');
}

/**
 * Seeing and ending another member's mark-offs (Cedar ViewMemberAvailability /
 * EndMemberMarkoff, AVAILABILITY_OFFICER_GROUPS): OFFICER, CHIEF, ADMIN.
 */
export function canManageMemberAvailability(roles: readonly Role[]): boolean {
  return (['OFFICER', 'CHIEF', 'ADMIN'] as const).some((r) => roles.includes(r));
}

/** Equipment and PPE writes (Cedar INVENTORY_ADMIN_GROUPS). */
export function canManageInventory(roles: readonly Role[]): boolean {
  return (['OFFICER', 'CHIEF', 'ADMIN'] as const).some((r) => roles.includes(r));
}

/** Highest-authority first. Cognito group order is arbitrary, so anything that shows a single
 * role (dashboard choice, the top-bar label) picks by this order, never roles[0]. */
export const ROLE_PRIORITY: readonly Role[] = [
  'CHIEF',
  'ADMIN',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'MEMBER',
];

export function primaryRole(roles: readonly Role[]): Role {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'MEMBER';
}
