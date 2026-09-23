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
