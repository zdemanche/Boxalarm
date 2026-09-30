import type { Role } from '../../auth/AuthContext';
import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { ApparatusStatus } from './types';

/** Cedar UpdateServiceStatus: APPARATUS_OFFICER_GROUPS (the web's canUpdateServiceStatus). */
export const SERVICE_STATUS_ROLES: readonly Role[] = ['APPARATUS', 'OFFICER', 'CHIEF', 'ADMIN'];

/**
 * PUT apparatus/{unitId}/service-status (apparatus-service serviceStatusHandler.ts, Cedar
 * UpdateServiceStatus). Online only: a unit's status is what the department acts on, so it is
 * never queued to land later. 204 on success; 409 when the unit is already in that status.
 */
export async function setServiceStatus(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  unitId: string,
  status: ApparatusStatus,
  reason?: string,
): Promise<void> {
  await apiRequest(`apparatus/${encodeURIComponent(unitId)}/service-status`, tokens, {
    apiBaseUrl,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
  });
}
