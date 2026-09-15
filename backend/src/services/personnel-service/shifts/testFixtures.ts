import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type TestDutyShiftItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'DUTY_SHIFT';
  readonly startAt: number;
  readonly endAt: number;
  readonly status: string;
};

export type TestShiftPositionItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'SHIFT_POSITION';
  readonly positionCode: string;
  readonly claimedByMemberId?: string;
  readonly claimedAt?: number;
};

export function buildDutyShift(
  deptId: VerifiedDeptId,
  shiftId: string,
  overrides: Partial<Pick<TestDutyShiftItem, 'startAt' | 'endAt' | 'status'>> = {},
): TestDutyShiftItem {
  return {
    pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId),
    sk: 'METADATA',
    entityType: 'DUTY_SHIFT',
    startAt: overrides.startAt ?? 1_800_000_000,
    endAt: overrides.endAt ?? 1_800_028_800,
    status: overrides.status ?? 'OPEN',
  };
}

export function buildShiftPosition(
  deptId: VerifiedDeptId,
  shiftId: string,
  positionCode: string,
  overrides: Partial<Pick<TestShiftPositionItem, 'claimedByMemberId' | 'claimedAt'>> = {},
): TestShiftPositionItem {
  return {
    pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId),
    sk: `POSITION#${positionCode}`,
    entityType: 'SHIFT_POSITION',
    positionCode,
    ...(overrides.claimedByMemberId !== undefined
      ? { claimedByMemberId: overrides.claimedByMemberId }
      : {}),
    ...(overrides.claimedAt !== undefined ? { claimedAt: overrides.claimedAt } : {}),
  };
}
