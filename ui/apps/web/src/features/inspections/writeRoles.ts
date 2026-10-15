import type { Role } from '../../auth/AuthContext';

export const INSPECTIONS_WRITE_ROLES: readonly Role[] = ['OFFICER', 'CHIEF', 'ADMIN'];

export const hasInspectionsWrite = (roles: readonly Role[]): boolean =>
  INSPECTIONS_WRITE_ROLES.some((role) => roles.includes(role));
