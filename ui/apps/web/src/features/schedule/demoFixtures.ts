import { DEMO_STATION } from '../../lib/demoRoster';
import type {
  CoverageStatus,
  DutyShift,
  PendingShiftSwap,
  ShiftCoverage,
  ShiftCoveragePosition,
  ShiftStatus,
} from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

/** Deterministic 0..1 for a seed - the schedule must look the same on every load. */
function hash01(seed: number): number {
  return (((seed + 1) * 2654435761) >>> 0) / 4294967296;
}

/** Local midnight `offsetDays` from today. */
function dayStart(offsetDays: number): Date {
  const date = new Date(NOW + offsetDays * DAY_MS);
  date.setHours(0, 0, 0, 0);
  return date;
}

function shiftId(offsetDays: number, kind: 'night' | 'day'): string {
  // Tonight's standby keeps its id: the dashboard and the pending swaps point at it.
  if (offsetDays === 0 && kind === 'night') return 's-tonight';
  const day = dayStart(offsetDays);
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  return `s-${stamp}-${kind}`;
}

function statusFor(offsetDays: number, kind: 'night' | 'day'): ShiftStatus {
  if (offsetDays === 0 && kind === 'night') return 'PARTIALLY_FILLED';
  const roll = hash01(offsetDays * 2 + (kind === 'day' ? 1 : 0) + 100);
  if (offsetDays < 0) return roll < 0.7 ? 'FULL' : 'PARTIALLY_FILLED';
  if (offsetDays === 9 && kind === 'day') return 'CANCELLED';
  if (roll < 0.4) return 'FULL';
  if (roll < 0.75) return 'PARTIALLY_FILLED';
  return 'OPEN';
}

interface ShiftSeed {
  offsetDays: number;
  kind: 'night' | 'day';
}

// The last 7 days and the next 14: an 18:00-06:00 standby every night, plus a 06:00-18:00 day
// shift on Saturdays and Sundays.
const SHIFT_SEEDS: ShiftSeed[] = [];
for (let offset = -7; offset <= 14; offset += 1) {
  const weekday = dayStart(offset).getDay();
  if (weekday === 0 || weekday === 6) SHIFT_SEEDS.push({ offsetDays: offset, kind: 'day' });
  SHIFT_SEEDS.push({ offsetDays: offset, kind: 'night' });
}

function buildShift({ offsetDays, kind }: ShiftSeed): DutyShift {
  const start = dayStart(offsetDays).getTime() + (kind === 'night' ? 18 : 6) * HOUR_MS;
  return {
    shiftId: shiftId(offsetDays, kind),
    startAt: start,
    endAt: start + 12 * HOUR_MS,
    stationId: DEMO_STATION.stationId,
    status: statusFor(offsetDays, kind),
  };
}

let shifts: DutyShift[] = SHIFT_SEEDS.map(buildShift);

const POSITION_CODES = ['OFF', 'DRIVER', 'FF', 'FF'] as const;

function positionsFor(shift: DutyShift, seed: number): ShiftCoveragePosition[] {
  return POSITION_CODES.map((positionCode, index) => {
    const requiredQual =
      positionCode === 'DRIVER'
        ? 'DRIVER_OPERATOR'
        : positionCode === 'OFF'
          ? 'OFFICER'
          : undefined;
    let status: CoverageStatus = 'covered';
    if (shift.status === 'OPEN') status = 'short';
    else if (shift.status === 'PARTIALLY_FILLED') {
      // Tonight is short a driver (the pending swap below); other partial shifts vary.
      const roll = hash01(seed * 10 + index);
      if (shift.shiftId === 's-tonight') status = positionCode === 'DRIVER' ? 'short' : 'covered';
      else if (roll < 0.25) status = 'short';
      else if (roll < 0.35) status = 'qual-gapped';
    }
    return { positionCode, ...(requiredQual ? { requiredQual } : {}), status };
  });
}

// Coverage for the coming week: each shift's officer, driver and two firefighter seats.
const coverage: ShiftCoverage[] = shifts
  .filter((shift) => shift.endAt > NOW && shift.startAt < NOW + 7 * DAY_MS)
  .filter((shift) => shift.status !== 'CANCELLED')
  .map((shift, index) => {
    const positions = positionsFor(shift, index);
    const status: CoverageStatus = positions.some((p) => p.status === 'qual-gapped')
      ? 'qual-gapped'
      : positions.some((p) => p.status === 'short')
        ? 'short'
        : 'covered';
    return {
      shiftId: shift.shiftId,
      startAt: shift.startAt,
      endAt: shift.endAt,
      stationId: shift.stationId,
      status,
      positions,
    };
  });

// Two swaps waiting on an officer: Lindqvist handing tonight's driver seat to Kim, and Brooks
// giving tomorrow night's firefighter seat to Marchetti. The swap id is its requestedAt.
let pendingSwaps: PendingShiftSwap[] = [
  {
    shiftId: 's-tonight',
    positionCode: 'DRIVER',
    fromMemberId: 'm-13',
    toMemberId: 'm-12',
    status: 'PENDING',
    requiresOfficerApproval: true,
    requestedAt: NOW - 3 * HOUR_MS,
  },
  {
    shiftId: shiftId(1, 'night'),
    positionCode: 'FF',
    fromMemberId: 'm-16',
    toMemberId: 'm-18',
    status: 'PENDING',
    requiresOfficerApproval: true,
    requestedAt: NOW - 26 * HOUR_MS,
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tryHandleScheduleExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'personnel' || parts[1] !== 'shifts') return undefined;

  if (parts.length === 2 && method === 'GET') return json({ shifts });
  if (parts.length === 2 && method === 'POST') {
    const created: DutyShift = {
      shiftId: `s-${shifts.length + 1}`,
      startAt: body.startAt as number,
      endAt: body.endAt as number,
      stationId: body.stationId as string,
      status: 'OPEN',
    };
    shifts = [...shifts, created];
    return json({ ...created, positions: body.positions }, 201);
  }
  if (parts[2] === 'coverage' && method === 'GET') return json({ shifts: coverage });
  if (parts[2] === 'swaps' && parts[3] === 'pending' && method === 'GET') {
    return json({ swaps: pendingSwaps });
  }
  if (parts[3] === 'swap' && parts[5] === 'approve' && method === 'POST') {
    const swapId = Number(parts[4]);
    const approved = pendingSwaps.find(
      (swap) => swap.shiftId === parts[2] && swap.requestedAt === swapId,
    );
    pendingSwaps = pendingSwaps.filter((swap) => swap !== approved);
    return json({
      shiftId: parts[2],
      swapId,
      status: 'APPROVED',
      claimedByMemberId: approved?.toMemberId ?? 'm-demo',
    });
  }

  return undefined;
}
