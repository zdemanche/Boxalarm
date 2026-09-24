import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { LosapPointRules, LosapRuleVersion } from './types';

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
