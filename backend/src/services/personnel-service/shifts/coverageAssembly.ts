export type CoverageStatus = 'covered' | 'short' | 'qual-gapped';

export interface CoveragePositionInput {
  readonly positionCode: string;
  readonly requiredQual?: string;
  readonly claimedByMemberId?: string;
}

export interface CoverageShiftInput {
  readonly shiftId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly stationId: string;
  readonly positions: readonly CoveragePositionInput[];
}

export interface ShiftCoveragePositionEntry {
  readonly positionCode: string;
  readonly requiredQual?: string;
  readonly status: CoverageStatus;
}

export interface ShiftCoverageEntry {
  readonly shiftId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly stationId: string;
  readonly status: CoverageStatus;
  readonly positions: readonly ShiftCoveragePositionEntry[];
}

function rollUpStatus(positions: readonly ShiftCoveragePositionEntry[]): CoverageStatus {
  if (positions.some((position) => position.status === 'qual-gapped')) {
    return 'qual-gapped';
  }
  if (positions.some((position) => position.status === 'short')) {
    return 'short';
  }
  return 'covered';
}

export function classifyPosition(
  position: CoveragePositionInput,
  eligibleQualCodes: ReadonlySet<string>,
): CoverageStatus {
  if (position.claimedByMemberId !== undefined) {
    return 'covered';
  }
  if (position.requiredQual !== undefined && !eligibleQualCodes.has(position.requiredQual)) {
    return 'qual-gapped';
  }
  return 'short';
}

export function assembleShiftCoverage(
  shift: CoverageShiftInput,
  eligibleQualCodes: ReadonlySet<string>,
): ShiftCoverageEntry {
  const positions = shift.positions.map((position) => ({
    positionCode: position.positionCode,
    ...(position.requiredQual !== undefined ? { requiredQual: position.requiredQual } : {}),
    status: classifyPosition(position, eligibleQualCodes),
  }));
  return {
    shiftId: shift.shiftId,
    startAt: shift.startAt,
    endAt: shift.endAt,
    stationId: shift.stationId,
    status: rollUpStatus(positions),
    positions,
  };
}
