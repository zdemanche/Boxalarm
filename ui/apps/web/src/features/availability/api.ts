import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';

export interface MarkOffInput {
  /** Epoch seconds, as personnel-service availability/handler.ts requires. */
  startAt: number;
  endAt: number;
  reason?: string;
}

export interface MarkOff extends MarkOffInput {
  memberId: string;
  affectsAlerting: boolean;
}

/** POST personnel/members/{memberId}/availability (MarkAvailability, own record only). */
export async function markUnavailable(
  tokens: AuthTokenSource,
  memberId: string,
  input: MarkOffInput,
): Promise<MarkOff> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/availability`,
    tokens,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return (await response.json()) as MarkOff;
}
