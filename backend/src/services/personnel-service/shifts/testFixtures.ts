import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type TestDutyShiftItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'DUTY_SHIFT';
  readonly shiftId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly status: string;
  readonly gsi3pk: string;
  readonly gsi3sk: string;
};

export type TestShiftPositionItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'SHIFT_POSITION';
  readonly positionCode: string;
  readonly requiredQual?: string;
  readonly claimedByMemberId?: string;
  readonly claimedAt?: number;
};

export type TestMemberQualificationItem = Readonly<Record<'pk' | 'sk', string>> & {
  readonly entityType: 'MEMBER_QUALIFICATION';
  readonly qualCode: string;
  readonly grantedByCertId: string | null;
  readonly currentlyEligible: boolean;
};

export function buildDutyShift(
  deptId: VerifiedDeptId,
  shiftId: string,
  overrides: Partial<Pick<TestDutyShiftItem, 'startAt' | 'endAt' | 'status'>> = {},
): TestDutyShiftItem {
  const startAt = overrides.startAt ?? 1_800_000_000;
  return {
    pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId),
    sk: 'METADATA',
    entityType: 'DUTY_SHIFT',
    shiftId,
    startAt,
    endAt: overrides.endAt ?? 1_800_028_800,
    status: overrides.status ?? 'OPEN',
    gsi3pk: buildDeptScopedPk(deptId, 'DUTY_SHIFT'),
    gsi3sk: String(startAt),
  };
}

export function buildShiftPosition(
  deptId: VerifiedDeptId,
  shiftId: string,
  positionCode: string,
  overrides: Partial<
    Pick<TestShiftPositionItem, 'claimedByMemberId' | 'claimedAt' | 'requiredQual'>
  > = {},
): TestShiftPositionItem {
  return {
    pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId),
    sk: `POSITION#${positionCode}`,
    entityType: 'SHIFT_POSITION',
    positionCode,
    ...(overrides.requiredQual !== undefined ? { requiredQual: overrides.requiredQual } : {}),
    ...(overrides.claimedByMemberId !== undefined
      ? { claimedByMemberId: overrides.claimedByMemberId }
      : {}),
    ...(overrides.claimedAt !== undefined ? { claimedAt: overrides.claimedAt } : {}),
  };
}

export function buildMemberQualification(
  deptId: VerifiedDeptId,
  memberId: string,
  qualCode: string,
  overrides: Partial<
    Pick<TestMemberQualificationItem, 'grantedByCertId' | 'currentlyEligible'>
  > = {},
): TestMemberQualificationItem {
  return {
    pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    sk: `QUAL#${qualCode}`,
    entityType: 'MEMBER_QUALIFICATION',
    qualCode,
    grantedByCertId: overrides.grantedByCertId ?? null,
    currentlyEligible: overrides.currentlyEligible ?? true,
  };
}
