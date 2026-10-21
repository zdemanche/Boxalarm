import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { ConfigResponse } from '../platform/types';
import type { LosapPointRules, LosapRuleVersion } from './types';

export async function getLosapRules(tokens: AuthTokenSource): Promise<ConfigResponse> {
  const response = await apiRequest('platform/config/LOSAP_POINT_RULES', tokens);
  return (await response.json()) as ConfigResponse;
}

export async function updateLosapRules(
  tokens: AuthTokenSource,
  pointsByActivityType: LosapPointRules,
): Promise<LosapRuleVersion> {
  const response = await apiRequest('personnel/losap/rules', tokens, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointsByActivityType }),
  });
  return (await response.json()) as LosapRuleVersion;
}
