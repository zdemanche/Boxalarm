import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface CreateShiftPositionInput {
  readonly positionCode: string;
  readonly requiredQual?: string;
}

export interface CreateShiftRequest {
  readonly startAt: number;
  readonly endAt: number;
  readonly stationId: string;
  readonly positions: readonly CreateShiftPositionInput[];
}

const MAX_POSITIONS = 99;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePosition(value: unknown, index: number): CreateShiftPositionInput {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`positions[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.positionCode)) {
    throw new ValidationError(
      `positions[${index}].positionCode is required and must be a non-empty string`,
    );
  }
  if (record.requiredQual !== undefined && !isNonEmptyString(record.requiredQual)) {
    throw new ValidationError(
      `positions[${index}].requiredQual must be a non-empty string when present`,
    );
  }
  return record.requiredQual === undefined
    ? { positionCode: record.positionCode }
    : { positionCode: record.positionCode, requiredQual: record.requiredQual };
}

export function parseCreateShiftRequest(body: unknown): CreateShiftRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body is required');
  }
  const record = body as Record<string, unknown>;

  if (!isFiniteNumber(record.startAt)) {
    throw new ValidationError('startAt must be a finite epoch number');
  }
  if (!isFiniteNumber(record.endAt)) {
    throw new ValidationError('endAt must be a finite epoch number');
  }
  if (record.endAt <= record.startAt) {
    throw new ValidationError('endAt must be after startAt');
  }
  if (!isNonEmptyString(record.stationId)) {
    throw new ValidationError('stationId is required and must be a non-empty string');
  }
  if (!Array.isArray(record.positions)) {
    throw new ValidationError('positions must be an array');
  }
  if (record.positions.length === 0) {
    throw new ValidationError('at least one position is required');
  }
  if (record.positions.length > MAX_POSITIONS) {
    throw new ValidationError(`positions cannot exceed ${MAX_POSITIONS} entries`);
  }

  const positions = record.positions.map((position, index) => parsePosition(position, index));
  const seenPositionCodes = new Set<string>();
  positions.forEach((position, index) => {
    if (seenPositionCodes.has(position.positionCode)) {
      throw new ValidationError(`positions[${index}].positionCode is duplicated`);
    }
    seenPositionCodes.add(position.positionCode);
  });

  return {
    startAt: record.startAt,
    endAt: record.endAt,
    stationId: record.stationId,
    positions,
  };
}

export function buildShiftTransactItems(
  deptId: VerifiedDeptId,
  shiftId: string,
  tableName: string,
  input: CreateShiftRequest,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
  const gsi3pk = buildDeptScopedPk(deptId, 'DUTY_SHIFT');

  const shiftItem: TransactWriteCommandInput['TransactItems'] = [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk,
          sk: 'METADATA',
          entityType: 'DUTY_SHIFT',
          shiftId,
          startAt: input.startAt,
          endAt: input.endAt,
          stationId: input.stationId,
          status: 'OPEN',
          gsi3pk,
          gsi3sk: String(input.startAt),
        },
      },
    },
  ];

  const positionItems: TransactWriteCommandInput['TransactItems'] = input.positions.map(
    (position) => ({
      Put: {
        TableName: tableName,
        Item: {
          pk,
          sk: `POSITION#${position.positionCode}`,
          entityType: 'SHIFT_POSITION',
          shiftId,
          positionCode: position.positionCode,
          ...(position.requiredQual !== undefined ? { requiredQual: position.requiredQual } : {}),
        },
      },
    }),
  );

  return [...shiftItem, ...positionItems];
}

export interface ShiftListEntry {
  readonly shiftId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly stationId: string;
  readonly status: string;
}

export function parseShiftListItems(items: readonly Record<string, unknown>[]): ShiftListEntry[] {
  return items.map((item) => ({
    shiftId: String(item.shiftId),
    startAt: Number(item.startAt),
    endAt: Number(item.endAt),
    stationId: String(item.stationId),
    status: String(item.status),
  }));
}
