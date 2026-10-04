import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

export class ForbiddenError extends Error {}

const ADMIN_GATED_GROUPS = new Set(['ADMIN', 'OFFICER', 'CHIEF']);

export type AuthzDecision = 'allow' | 'deny';

// TODO: E8-S3 replace this cognito:groups check with IsAuthorizedWithToken (Verified
// Permissions / Cedar) once the policy store lands; this is the single seam every
// admin-gate call goes through, so the swap touches only this function.
export function isAuthorized(ctx: VerifiedAccessToken): AuthzDecision {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  return groups.some((group) => ADMIN_GATED_GROUPS.has(group)) ? 'allow' : 'deny';
}

export function requireAdminRole(ctx: VerifiedAccessToken): void {
  if (isAuthorized(ctx) === 'deny') {
    throw new ForbiddenError('caller does not hold an admin-gated role (ADMIN, OFFICER, or CHIEF)');
  }
}

/**
 * Assigning roles is CHIEF/ADMIN only (F2.7). OFFICER passes requireAdminRole, so reusing
 * it here would let an officer grant themselves or a friend ADMIN.
 */
const ROLE_MANAGER_GROUPS = new Set(['ADMIN', 'CHIEF']);

/**
 * LOSAP point rules are department configuration (architecture: LOSAP_POINT_RULES is a
 * DEPARTMENT_CONFIG type written through PUT /platform/config, UpdateConfig = CHIEF/ADMIN; the
 * PRD gives membership and LOSAP points to the administrator). They drive a member benefit, so
 * OFFICER - admitted by requireAdminRole - may not rewrite them (security-web MINOR 11).
 */
export function requireLosapRulesManager(ctx: VerifiedAccessToken): void {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ROLE_MANAGER_GROUPS.has(group))) {
    throw new ForbiddenError('only ADMIN or CHIEF may change LOSAP point rules');
  }
}

/** Reinstating a RETIRED member is CHIEF/ADMIN only, like the protected-target rule below. */
export function requireReinstatementAuthority(ctx: VerifiedAccessToken): void {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ROLE_MANAGER_GROUPS.has(group))) {
    throw new ForbiddenError('only ADMIN or CHIEF may reinstate a RETIRED member');
  }
}

export function requireRoleManager(ctx: VerifiedAccessToken): void {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ROLE_MANAGER_GROUPS.has(group))) {
    throw new ForbiddenError('only ADMIN or CHIEF may change member roles');
  }
}

/**
 * Review M5: OFFICER passes requireAdminRole, and LOA/RETIRED ends every session and takes a
 * member out of paging. Without this one compromised officer password (single-factor by
 * design) could silently remove the chief and the admins from alerting and sign them out.
 * A CHIEF or ADMIN target's status is therefore changed only by a CHIEF or ADMIN.
 */
const PROTECTED_TARGET_ROLES = new Set(['ADMIN', 'CHIEF']);

export function requireStatusAuthorityOver(
  ctx: VerifiedAccessToken,
  targetRoles: readonly string[] | undefined,
): void {
  if (!(targetRoles ?? []).some((role) => PROTECTED_TARGET_ROLES.has(role))) {
    return;
  }
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ROLE_MANAGER_GROUPS.has(group))) {
    throw new ForbiddenError(
      'only ADMIN or CHIEF may change the status of a CHIEF or ADMIN member',
    );
  }
}
