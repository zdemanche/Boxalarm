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
