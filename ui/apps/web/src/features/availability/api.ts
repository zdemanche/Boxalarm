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

/** One of a member's current or upcoming mark-offs (GET .../availability). */
export interface ListedMarkOff {
  /** The mark-off's startAt, as a string: the id the end route takes. */
  markoffId: string;
  startAt: number;
  endAt: number;
  reason?: string;
}

/** GET personnel/members/{memberId}/availability - own record, or OFFICER/CHIEF/ADMIN. */
export async function listMarkOffs(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<ListedMarkOff[]> {
  const response = await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/availability`,
    tokens,
  );
  return ((await response.json()) as { markOffs: ListedMarkOff[] }).markOffs;
}

/** POST .../availability/{markoffId}/end - ends a current mark-off now, cancels an upcoming one. */
export async function endMarkOff(
  tokens: AuthTokenSource,
  memberId: string,
  markoffId: string,
): Promise<void> {
  await apiRequest(
    `personnel/members/${encodeURIComponent(memberId)}/availability/${encodeURIComponent(markoffId)}/end`,
    tokens,
    { method: 'POST' },
  );
}
