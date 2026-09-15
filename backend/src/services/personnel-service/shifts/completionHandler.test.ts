import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';
import { createFakeDocumentClient } from './testDynamoFake.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const SHIFT_ID = 'SHIFT-0511';
const START_AT = 1_800_000_000;
const END_AT = 1_800_028_800;
const NOW = END_AT + 60;

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
    expect(doc.peek(`DEPT#NICHOLS#MEMBER#MBR-0012`, `ATTENDANCE#${END_AT}`)?.refId).toBe(SHIFT_ID);
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
});
