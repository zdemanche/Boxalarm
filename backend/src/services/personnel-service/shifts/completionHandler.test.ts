import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';
import { createFakeDocumentClient } from './testDynamoFake.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const SHIFT_ID = 'SHIFT-0511';
// DUTY_SHIFT.startAt/endAt are epoch MILLISECONDS (see completeShiftAttendance.ts's module doc
// comment). ATTENDANCE_RECORD.occurredAt is epoch SECONDS (see attendance/handler.ts) — that
// conversion is what END_AT_SECONDS below reproduces for the ATTENDANCE key assertion.
const START_AT = 1_800_000_000_000;
const END_AT = START_AT + 8 * 3_600_000;
const END_AT_SECONDS = END_AT / 1000;
const NOW = END_AT + 60_000;

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('completionHandler (entrypoint)', () => {
  it('rethrows on a malformed payload', async () => {
    const { handler } = await import('./completionHandler.js');
    await expect(handler({ shiftId: 'SHIFT-1' })).rejects.toThrow(
      'shift completion payload failed shape validation',
    );
  });

  it('completes a single ended claimed shift from the event payload (AC1)', async () => {
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
    ]);
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        getDocClient: () => doc as unknown as DynamoDBDocumentClient,
      };
    });

    const { handler } = await import('./completionHandler.js');
    const result = await handler({ deptId: 'NICHOLS', shiftId: SHIFT_ID, asOf: NOW });

    expect(result.outcomes).toEqual([
      { shiftId: SHIFT_ID, outcome: { kind: 'COMPLETED', recordsCreated: 1 } },
    ]);
    expect(doc.peek(`DEPT#NICHOLS#MEMBER#MBR-0012`, `ATTENDANCE#${END_AT_SECONDS}`)?.refId).toBe(
      SHIFT_ID,
    );
  });

  it('sweeps ended claimed shifts when shiftId is omitted', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'WORK_DETAIL',
        status: 'FULL',
      }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        claimedAt: START_AT,
      }),
    ]);
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        getDocClient: () => doc as unknown as DynamoDBDocumentClient,
      };
    });

    const { handler } = await import('./completionHandler.js');
    const result = await handler({ deptId: 'NICHOLS', asOf: NOW });

    expect(result.outcomes).toEqual([
      { shiftId: SHIFT_ID, outcome: { kind: 'COMPLETED', recordsCreated: 1 } },
    ]);
  });

  it('PR #150 review finding #4 regression: a malformed shift does not abort the rest of the sweep — later shifts still complete', async () => {
    const BAD_SHIFT_ID = 'SHIFT-MALFORMED';
    const GOOD_SHIFT_ID = 'SHIFT-GOOD';
    // A legacy/corrupt DUTY_SHIFT record: has a valid ended endAt (so the GSI3 sweep query picks
    // it up) but is missing numeric startAt, which makes completeShiftAttendance throw. Built by
    // hand (not buildDutyShift) specifically to omit startAt.
    const malformedShift = {
      pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', BAD_SHIFT_ID),
      sk: 'METADATA',
      entityType: 'DUTY_SHIFT',
      shiftId: BAD_SHIFT_ID,
      endAt: END_AT,
      status: 'FULL',
      gsi3pk: buildDeptScopedPk(DEPT_ID, 'DUTY_SHIFT'),
      gsi3sk: String(START_AT),
    };
    const doc = createFakeDocumentClient([
      malformedShift,
      buildShiftPosition(DEPT_ID, BAD_SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-BAD',
        claimedAt: START_AT,
      }),
      buildDutyShift(DEPT_ID, GOOD_SHIFT_ID, {
        startAt: START_AT,
        endAt: END_AT,
        activityType: 'STANDBY',
        status: 'FULL',
      }),
      buildShiftPosition(DEPT_ID, GOOD_SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-GOOD',
        claimedAt: START_AT,
      }),
    ]);
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        getDocClient: () => doc as unknown as DynamoDBDocumentClient,
      };
    });

    const { handler } = await import('./completionHandler.js');
    const result = await handler({ deptId: 'NICHOLS', asOf: NOW });

    expect(result.outcomes).toHaveLength(2);
    const badOutcome = result.outcomes.find((entry) => entry.shiftId === BAD_SHIFT_ID);
    const goodOutcome = result.outcomes.find((entry) => entry.shiftId === GOOD_SHIFT_ID);
    expect(badOutcome?.outcome.kind).toBe('FAILED');
    expect(goodOutcome?.outcome).toEqual({ kind: 'COMPLETED', recordsCreated: 1 });
    // The valid shift actually got its attendance written despite the earlier shift failing.
    expect(doc.peek(`DEPT#NICHOLS#MEMBER#MBR-GOOD`, `ATTENDANCE#${END_AT_SECONDS}`)?.refId).toBe(
      GOOD_SHIFT_ID,
    );
  });
});
