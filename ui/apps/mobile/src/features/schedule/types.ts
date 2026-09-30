// Shaped to match architecture.md's DUTY_SHIFT and SHIFT_POSITION entities (Data Model §3.3).

export type ShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL' | 'CANCELLED';

export interface ShiftPosition {
  positionCode: string;
  requiredQual: string | null;
  claimedByMemberId: string | null;
}

export interface DutyShift {
  shiftId: string;
  /** Epoch milliseconds, as personnel-service stores DUTY_SHIFT.startAt/endAt. */
  startAt: number;
  endAt: number;
  stationId: string;
  status: ShiftStatus;
  positions: ShiftPosition[];
}

// F2.9: an atomic claim either succeeds or discovers the position was already taken - never a
// silent "maybe." The UI shows PENDING between the tap and this result, never CLAIMED early.
// ALREADY_MINE mirrors the backend's claimShiftPosition.ts ClaimOutcome: this exact member
// already holds the position (an idempotent retry, e.g. a reconnect resubmit of a claim that
// actually succeeded before the connection dropped) - never conflate this with ALREADY_TAKEN
// (the backend's CONFLICT: someone else holds it), or a successful resubmit misleadingly reads
// as a lost shift.
export type ClaimResult = 'CLAIMED' | 'ALREADY_MINE' | 'ALREADY_TAKEN';

/** Claiming has to be atomic on the server (F2.9), so it is never queued or guessed offline. */
export class ClaimNeedsConnectionError extends Error {
  constructor() {
    super(
      "You need a connection to claim a shift - claiming has to be instant so two people can't take the same one.",
    );
    this.name = 'ClaimNeedsConnectionError';
  }
}

export interface MarkUnavailableResult {
  readonly outboxId: string | null;
  /** Older mark-offs from this phone that had not been sent yet and were dropped for this one. */
  readonly replacedUnsent?: number;
  /** Older mark-offs from this phone that were already sent (maybe landed), so they were kept. */
  readonly earlierMayStand?: number;
}

/**
 * One of the member's current or upcoming mark-offs (GET personnel/members/{id}/availability).
 * Times are epoch seconds, as the server stores MARKOFF#{startAt}.
 */
export interface MarkOff {
  /** The server's id for it; the start time as a string when the server sends none. */
  readonly markoffId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly reason?: string;
}

/**
 * Ending a mark-off early changes whether the member is paged right now, so it is never queued:
 * a queued "I'm available again" that lands later would leave them unpaged in between while the
 * app said otherwise.
 */
export class MarkOffNeedsConnectionError extends Error {
  constructor() {
    super(
      "You're offline. Ending a mark-off needs signal - you're still marked unavailable. Try again with signal, or tell an officer.",
    );
    this.name = 'MarkOffNeedsConnectionError';
  }
}

/** No member id on the session: nothing is queued or cached under a shared/blank key. */
export class NotSignedInError extends Error {
  constructor() {
    super('Sign in again to do this - this phone has no signed-in member.');
    this.name = 'NotSignedInError';
  }
}

export interface ScheduleRepository {
  getShifts(): Promise<DutyShift[]>;
  /** Epoch ms of the cached shift list the last getShifts() returned; null when it was live.
   * Optional: the mock repository never serves from cache. */
  shiftsCachedAt?(): number | null;
  // idempotencyKey is optional so existing single-attempt callers/tests are unaffected, but a
  // caller that may retry the same claim intent (e.g. ShiftDetailScreen's offline-queue reconnect
  // resubmit) must generate it once, up front, and pass the same value on every retry - a value
  // regenerated per attempt cannot function as an idempotency key across retries.
  claimPosition(
    shiftId: string,
    positionCode: string,
    idempotencyKey?: string,
  ): Promise<ClaimResult>;
  /** Queues the mark-off in the sync outbox (it is a member-owned write that works offline,
   * design.md §4.2) and resolves once it is saved on this phone - not once the server has it.
   * The returned outboxId lets the screen show honest delivery state; null from the mock. */
  markUnavailable(startAt: string, endAt: string, reason?: string): Promise<MarkUnavailableResult>;
  /** The member's current and upcoming mark-offs, soonest first. Online only. */
  listMarkOffs?(): Promise<MarkOff[]>;
  /** Ends a mark-off now ("I'm available again"). Online only; throws when offline. */
  endMarkOff?(markoffId: string): Promise<void>;
  // F2.11: give-back and swap. Optional so the original two-method mock (still exercised by
  // ShiftBoardScreen/AvailabilityScreen tests) needs no change to keep satisfying this interface.
  releasePosition?(shiftId: string, positionCode: string): Promise<void>;
  proposeSwap?(shiftId: string, positionCode: string, toMemberId: string): Promise<void>;
}
