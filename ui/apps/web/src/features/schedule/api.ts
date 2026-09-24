import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type { CreateShiftInput, DutyShift, ShiftCoverage, ShiftSwapApproval } from './types';

export async function listShifts(tokens: AuthTokenSource): Promise<DutyShift[]> {
  const response = await apiRequest('personnel/shifts', tokens);
  const body = (await response.json()) as { shifts: DutyShift[] };
  return body.shifts;
}

export async function createShift(
  tokens: AuthTokenSource,
  input: CreateShiftInput,
): Promise<DutyShift> {
  const response = await apiRequest('personnel/shifts', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as DutyShift;
}

export async function getShiftCoverage(tokens: AuthTokenSource): Promise<ShiftCoverage[]> {
  const response = await apiRequest('personnel/shifts/coverage', tokens);
  const body = (await response.json()) as { shifts: ShiftCoverage[] };
  return body.shifts;
}

export async function approveShiftSwap(
  tokens: AuthTokenSource,
  shiftId: string,
  swapId: string,
): Promise<ShiftSwapApproval> {
  const response = await apiRequest(
    `personnel/shifts/${encodeURIComponent(shiftId)}/swap/${encodeURIComponent(swapId)}/approve`,
    tokens,
    { method: 'POST' },
  );
  return (await response.json()) as ShiftSwapApproval;
}
