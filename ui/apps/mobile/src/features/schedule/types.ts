// Shaped to match architecture.md's DUTY_SHIFT and SHIFT_POSITION entities (Data Model §3.3).

export type ShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL' | 'CANCELLED';

export interface ShiftPosition {
  positionCode: string;
  requiredQual: string | null;
  claimedByMemberId: string | null;
}

export interface DutyShift {
  shiftId: string;
  startAt: string; // ISO
  endAt: string;
  stationId: string;
  status: ShiftStatus;
  positions: ShiftPosition[];
}

// F2.9: an atomic claim either succeeds or discovers the position was already taken - never a
// silent "maybe." The UI shows PENDING between the tap and this result, never CLAIMED early.
export type ClaimResult = 'CLAIMED' | 'ALREADY_TAKEN';

export interface ScheduleRepository {
  getShifts(): Promise<DutyShift[]>;
  claimPosition(shiftId: string, positionCode: string): Promise<ClaimResult>;
  markUnavailable(startAt: string, endAt: string, reason?: string): Promise<void>;
  // F2.11: give-back and swap. Optional so the original two-method mock (still exercised by
  // ShiftBoardScreen/AvailabilityScreen tests) needs no change to keep satisfying this interface.
  releasePosition?(shiftId: string, positionCode: string): Promise<void>;
  proposeSwap?(shiftId: string, positionCode: string, toMemberId: string): Promise<void>;
}
