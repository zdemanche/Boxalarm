import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { Apparatus, CreateApparatusInput } from './types';

export async function listApparatus(tokens: AuthTokenSource): Promise<Apparatus[]> {
  const response = await apiRequest('apparatus', tokens);
  const body = (await response.json()) as { items: Apparatus[] };
  return body.items;
}

export async function getApparatus(
  tokens: AuthTokenSource,
  apparatusId: string,
): Promise<Apparatus> {
  const response = await apiRequest(`apparatus/${encodeURIComponent(apparatusId)}`, tokens);
  return (await response.json()) as Apparatus;
}

export async function createApparatus(
  tokens: AuthTokenSource,
  input: CreateApparatusInput,
): Promise<Apparatus> {
  const response = await apiRequest('apparatus', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as Apparatus;
}
