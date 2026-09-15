import { describe, expect, it, vi } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildAttendanceKeys } from '../attendance/handler.js';
import {
  completeShiftAttendance,
  findEndedShiftsWithClaims,
  zeroLosapCalculator,
  type LosapPointsCalculator,
} from './completeShiftAttendance.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-service';
const SHIFT_ID = 'SHIFT-0511';
const MEMBER_ID = 'MBR-0012';
const START_AT = 1_800_000_000;
const END_AT = 1_800_028_800; // 8 hours later
const NOW_AFTER_END = END_AT + 60;

describe('completeShiftAttendance', () => {
  it('AC1: creates ATTENDANCE_RECORD with activityType STANDBY and refId=shiftId for a claimed ended shift', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
    });

    expect(outcome).toEqual({ kind: 'COMPLETED', recordsCreated: 1 });
    const attendance = doc.peek(
      buildDeptScopedPk(DEPT_ID, 'MEMBER', MEMBER_ID),
      `ATTENDANCE#${END_AT}`,
    );
    expect(attendance).toMatchObject({
      entityType: 'ATTENDANCE_RECORD',
      activityType: 'STANDBY',
      refId: SHIFT_ID,
      occurredAt: END_AT,
      hours: 8,
    });
  });

  it('AC1: creates ATTENDANCE_RECORD with activityType WORK_DETAIL when the shift is a work detail', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'WORK_DETAIL',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, { now: NOW_AFTER_END });

    const attendance = doc.peek(
      buildDeptScopedPk(DEPT_ID, 'MEMBER', MEMBER_ID),
      `ATTENDANCE#${END_AT}`,
    );
    expect(attendance?.activityType).toBe('WORK_DETAIL');
    expect(attendance?.refId).toBe(SHIFT_ID);
  });

  it('AC1: defaults activityType to STANDBY when the DUTY_SHIFT has no activityType', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, { startAt: START_AT, endAt: END_AT }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, { now: NOW_AFTER_END });

    const attendance = doc.peek(
      buildDeptScopedPk(DEPT_ID, 'MEMBER', MEMBER_ID),
      `ATTENDANCE#${END_AT}`,
    );
    expect(attendance?.activityType).toBe('STANDBY');
  });

  it('creates one attendance record per claimed position and skips unclaimed positions', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        claimedAt: START_AT,
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'OFFICER', {
        claimedByMemberId: 'MBR-0034',
        claimedAt: START_AT,
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'FF'),
    ]);

    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
    });

    expect(outcome).toEqual({ kind: 'COMPLETED', recordsCreated: 2 });
    expect(
      doc.peek(buildDeptScopedPk(DEPT_ID, 'MEMBER', 'MBR-0012'), `ATTENDANCE#${END_AT}`),
    ).toBeDefined();
    expect(
      doc.peek(buildDeptScopedPk(DEPT_ID, 'MEMBER', 'MBR-0034'), `ATTENDANCE#${END_AT}`),
    ).toBeDefined();
  });

  it('is idempotent: a second completion does not duplicate attendance (AC regression)', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    const first = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
    });
    const second = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END + 120,
    });

    expect(first).toEqual({ kind: 'COMPLETED', recordsCreated: 1 });
    expect(second).toEqual({ kind: 'ALREADY_COMPLETED' });
    expect(
      [...doc.all()].filter(
        (item) => item.entityType === 'ATTENDANCE_RECORD' && item.refId === SHIFT_ID,
      ),
    ).toHaveLength(1);
  });

  it('AC3: shift-derived attendance matches the manual ATTENDANCE_RECORD key/shape for reporting queries', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, { now: NOW_AFTER_END });

    const expectedKeys = buildAttendanceKeys(DEPT_ID, MEMBER_ID, END_AT);
    const attendance = doc.peek(expectedKeys.pk, expectedKeys.sk);
    expect(attendance).toMatchObject({
      ...expectedKeys,
      entityType: 'ATTENDANCE_RECORD',
      activityType: 'STANDBY',
      refId: SHIFT_ID,
      occurredAt: END_AT,
      hours: 8,
      losapPointsAwarded: 0,
      gsi1pk: `MEMBER#${MEMBER_ID}`,
      gsi1sk: `ATTENDANCE_RECORD#${END_AT}`,
    });
  });

  it('AC2: calls the LOSAP calculator and writes LOSAP_POINT_ENTRY when points are awarded', async () => {
    const compute = vi.fn().mockResolvedValue({ points: 3, ruleVersionId: 'RULE-v1' });
    const calculator: LosapPointsCalculator = { compute };
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
      losapCalculator: calculator,
    });

    expect(compute).toHaveBeenCalledWith({
      activityType: 'STANDBY',
      hours: 8,
      deptId: DEPT_ID,
      memberId: MEMBER_ID,
      shiftId: SHIFT_ID,
    });
    const attendance = doc.peek(
      buildDeptScopedPk(DEPT_ID, 'MEMBER', MEMBER_ID),
      `ATTENDANCE#${END_AT}`,
    );
    expect(attendance?.losapPointsAwarded).toBe(3);
    const losapEntries = [...doc.all()].filter((item) => item.entityType === 'LOSAP_POINT_ENTRY');
    expect(losapEntries).toHaveLength(1);
    expect(losapEntries[0]).toMatchObject({
      entityType: 'LOSAP_POINT_ENTRY',
      activityType: 'STANDBY',
      points: 3,
      sourceRefId: `ATTENDANCE#${END_AT}`,
      ruleVersionId: 'RULE-v1',
      gsi1pk: `MEMBER#${MEMBER_ID}`,
      gsi1sk: `LOSAP_POINT_ENTRY#${new Date(END_AT * 1000).getUTCFullYear()}`,
    });
  });

  it('calls the default zero LOSAP calculator and still emits personnel.attendance.recorded outbox', async () => {
    const compute = vi.spyOn(zeroLosapCalculator, 'compute');
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
      losapCalculator: zeroLosapCalculator,
    });

    expect(compute).toHaveBeenCalledOnce();
    const outbox = [...doc.all()].filter(
      (item) =>
        item.entityType === 'OUTBOX_ENTRY' && item.eventType === 'personnel.attendance.recorded',
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({
      deptId: DEPT_ID,
      memberId: MEMBER_ID,
      activityType: 'STANDBY',
      activityId: SHIFT_ID,
      losapPoints: 0,
    });
    expect([...doc.all()].filter((item) => item.entityType === 'LOSAP_POINT_ENTRY')).toHaveLength(
      0,
    );
    compute.mockRestore();
  });

  it('skips when the shift has not ended yet', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, { startAt: START_AT, endAt: END_AT }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: START_AT + 60,
    });

    expect(outcome).toEqual({ kind: 'SKIPPED_NOT_ENDED' });
    expect([...doc.all()].filter((item) => item.entityType === 'ATTENDANCE_RECORD')).toHaveLength(
      0,
    );
  });

  it('skips CANCELLED shifts and does not write attendance', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        status: 'CANCELLED',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
    ]);

    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
    });

    expect(outcome).toEqual({ kind: 'SKIPPED_CANCELLED' });
  });

  it('returns SKIPPED_NO_CLAIMS when no positions were claimed', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, { startAt: START_AT, endAt: END_AT }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, SHIFT_ID, {
      now: NOW_AFTER_END,
    });

    expect(outcome).toEqual({ kind: 'SKIPPED_NO_CLAIMS' });
  });

  it('returns NOT_FOUND when the shift does not exist', async () => {
    const doc = createFakeDocumentClient([]);
    const outcome = await completeShiftAttendance(doc, TABLE, DEPT_ID, 'missing', {
      now: NOW_AFTER_END,
    });
    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('findEndedShiftsWithClaims', () => {
  it('returns ended shifts that still have claimed positions and are not yet attendance-completed', async () => {
    const ended = buildDutyShift(DEPT_ID, 'SHIFT-ENDED', {
      startAt: START_AT,
      endAt: END_AT,
      status: 'FULL',
    });
    const stillOpen = buildDutyShift(DEPT_ID, 'SHIFT-OPEN', {
      startAt: NOW_AFTER_END,
      endAt: NOW_AFTER_END + 3600,
      status: 'OPEN',
    });
    const alreadyDone = buildDutyShift(DEPT_ID, 'SHIFT-DONE', {
      startAt: START_AT - 10_000,
      endAt: START_AT,
      status: 'FULL',
      attendanceCompletedAt: START_AT + 1,
    });
    const doc = createFakeDocumentClient([
      ended,
      buildShiftPosition(DEPT_ID, 'SHIFT-ENDED', 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT,
      }),
      stillOpen,
      buildShiftPosition(DEPT_ID, 'SHIFT-OPEN', 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: NOW_AFTER_END,
      }),
      alreadyDone,
      buildShiftPosition(DEPT_ID, 'SHIFT-DONE', 'DRIVER', {
        claimedByMemberId: MEMBER_ID,
        claimedAt: START_AT - 10_000,
      }),
    ]);

    const found = await findEndedShiftsWithClaims(doc, TABLE, DEPT_ID, NOW_AFTER_END);

    expect(found).toEqual(['SHIFT-ENDED']);
  });
});
