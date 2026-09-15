const RETENTION_ROLES = new Set(['CHIEF', 'ADMIN']);

export class ForbiddenError extends Error {}

function parseGroups(raw: string): readonly string[] {
  return raw.split(' ').filter((group) => group.length > 0);
}

// TODO: E8-S3 — swap for Cedar IsAuthorizedWithToken (fail-secure 503 on a Verified
// Permissions outage) once the E8-S3 Cedar gate lands. Until then this is the sole
// server-side check on this endpoint — role gate only, no password / step-up challenge.
export function assertChiefOrAdmin(cognitoGroupsRaw: string): void {
  const groups = parseGroups(cognitoGroupsRaw);
  if (!groups.some((group) => RETENTION_ROLES.has(group))) {
    throw new ForbiddenError('caller is not a CHIEF or ADMIN');
  }
}
