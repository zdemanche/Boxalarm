export interface RidingPosition {
  readonly code: string;
  readonly label: string;
  readonly requiredQual?: string;
}

export type PositionResolution =
  | { readonly kind: 'RESOLVED'; readonly position: RidingPosition }
  | { readonly kind: 'UNCONFIGURED_TYPE' }
  | { readonly kind: 'UNKNOWN_POSITION' };

export function resolveRidingPosition(
  apparatusType: string,
  positionsByType: Readonly<Record<string, readonly RidingPosition[]>>,
  positionCode: string,
): PositionResolution {
  const positions = positionsByType[apparatusType];
  if (positions === undefined) {
    return { kind: 'UNCONFIGURED_TYPE' };
  }
  const position = positions.find((candidate) => candidate.code === positionCode);
  return position ? { kind: 'RESOLVED', position } : { kind: 'UNKNOWN_POSITION' };
}

export function parseRidingPositionsConfig(
  value: Record<string, unknown> | undefined,
): Readonly<Record<string, readonly RidingPosition[]>> {
  if (!value) {
    return {};
  }
  const result: Record<string, readonly RidingPosition[]> = {};
  for (const [apparatusType, rawPositions] of Object.entries(value)) {
    if (!Array.isArray(rawPositions)) {
      continue;
    }
    const positions: RidingPosition[] = [];
    for (const rawPosition of rawPositions) {
      if (typeof rawPosition !== 'object' || rawPosition === null) {
        continue;
      }
      const record = rawPosition as Record<string, unknown>;
      const code = record.code;
      const label = record.label;
      if (typeof code !== 'string' || typeof label !== 'string') {
        continue;
      }
      const requiredQual = record.requiredQual;
      positions.push({
        code,
        label,
        ...(typeof requiredQual === 'string' ? { requiredQual } : {}),
      });
    }
    result[apparatusType] = positions;
  }
  return result;
}

export type SeatQualStatus = 'MET' | 'UNMET' | 'NO_REQUIREMENT';

export function seatQualStatus(
  requiredQual: string | undefined,
  memberQualCodes: ReadonlySet<string>,
): SeatQualStatus {
  if (requiredQual === undefined) {
    return 'NO_REQUIREMENT';
  }
  return memberQualCodes.has(requiredQual) ? 'MET' : 'UNMET';
}

export interface SeatState {
  readonly apparatusId: string;
  readonly positionCode: string;
  readonly memberId: string | null;
  readonly version: number;
  readonly assignedAt: number;
  readonly assignedBy: string;
}

export class RidingBoardWriteError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB write for the riding-board seat assignment failed');
    this.name = 'RidingBoardWriteError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export class RidingBoardReadError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('The riding board could not be read');
    this.name = 'RidingBoardReadError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}
