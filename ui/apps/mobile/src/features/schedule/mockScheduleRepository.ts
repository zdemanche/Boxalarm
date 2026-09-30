import type { ClaimResult, DutyShift, MarkOff, ScheduleRepository } from './types';

// Mark-offs made with the mock (no API): listed and ended in memory.
let MARK_OFFS: MarkOff[] = [];

/** Test seam. */
export function resetMockMarkOffs(markOffs: MarkOff[] = []): void {
  MARK_OFFS = [...markOffs];
}

const SHIFTS: DutyShift[] = [
  {
    shiftId: 'SHIFT-0511',
    startAt: Date.parse('2026-09-20T18:00:00Z'),
    endAt: Date.parse('2026-09-21T06:00:00Z'),
    stationId: 'STATION-1',
    status: 'PARTIALLY_FILLED',
    positions: [
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', claimedByMemberId: null },
      { positionCode: 'OFFICER', requiredQual: 'OFFICER', claimedByMemberId: 'MBR-0034' },
    ],
  },
  {
    shiftId: 'SHIFT-0512',
    startAt: Date.parse('2026-09-27T18:00:00Z'),
    endAt: Date.parse('2026-09-28T06:00:00Z'),
    stationId: 'STATION-1',
    status: 'OPEN',
    positions: [
      { positionCode: 'DRIVER', requiredQual: 'DRIVER_OPERATOR', claimedByMemberId: null },
      { positionCode: 'INTERIOR', requiredQual: 'INTERIOR', claimedByMemberId: null },
    ],
  },
];

// No backend access yet - stands in for platform-service's real atomic-claim endpoint (F2.9).
// claimPosition looks up the position's CURRENT claimedByMemberId at call time so a caller who
// fires two claims for the same position (the actual race F2.9 guards against) sees the second
// one resolve ALREADY_TAKEN, matching the real conditional-update semantics.
export const mockScheduleRepository: ScheduleRepository = {
  async getShifts() {
    return SHIFTS;
  },

  async claimPosition(shiftId, positionCode): Promise<ClaimResult> {
    const shift = SHIFTS.find((s) => s.shiftId === shiftId);
    const position = shift?.positions.find((p) => p.positionCode === positionCode);
    if (!position || position.claimedByMemberId !== null) {
      return 'ALREADY_TAKEN';
    }
    position.claimedByMemberId = 'MBR-0012';
    return 'CLAIMED';
  },

  async markUnavailable(startAt, endAt, reason) {
    const start = Math.floor(Date.parse(startAt) / 1000);
    MARK_OFFS = [
      ...MARK_OFFS.filter((m) => m.startAt !== start),
      {
        markoffId: String(start),
        startAt: start,
        endAt: Math.floor(Date.parse(endAt) / 1000),
        ...(reason ? { reason } : {}),
      },
    ].sort((a, b) => a.startAt - b.startAt);
    return { outboxId: null };
  },

  async listMarkOffs() {
    const now = Date.now() / 1000;
    return MARK_OFFS.filter((m) => m.endAt > now);
  },

  async endMarkOff(markOff) {
    MARK_OFFS = MARK_OFFS.filter((m) => m.markoffId !== markOff.markoffId);
  },

  async releasePosition(shiftId, positionCode) {
    const shift = SHIFTS.find((s) => s.shiftId === shiftId);
    const position = shift?.positions.find((p) => p.positionCode === positionCode);
    if (position) position.claimedByMemberId = null;
  },

  async proposeSwap() {
    return undefined;
  },
};
