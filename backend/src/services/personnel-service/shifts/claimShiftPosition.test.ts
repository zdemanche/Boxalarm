import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { claimShiftPosition, ShiftPositionWriteError } from './claimShiftPosition.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

describe('claimShiftPosition', () => {
  it('AC1: succeeds via a conditional UpdateItem and sets claimedByMemberId/claimedAt', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    const outcome = await claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome.kind).toBe('CLAIMED');
    expect(typeof (outcome as { claimedAt: number }).claimedAt).toBe('number');
  });

  it('AC2: exactly one of two simultaneous claims wins; the other gets a conflict, no double-booking', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    const [first, second] = await Promise.all([
      claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
      claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0034'),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(['CLAIMED', 'CONFLICT']);

    const winnerMemberId = first.kind === 'CLAIMED' ? 'MBR-0012' : 'MBR-0034';
    const pk = buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID);
    const finalItem = doc.peek(pk, 'POSITION#DRIVER');
    expect(finalItem?.claimedByMemberId).toBe(winnerMemberId);
  });

  it.todo(
    'AC2 (Tier-1 concurrency benchmark): exactly one of two simultaneous claims wins against real DynamoDB — architecture F2.9 Testing matrix requires an APIRequestContext run against a provisioned table; this build-only repo has no deployed table (internal/plan.md §3), so this benchmark is a tracked residual owned by the boxalarm-infrastructure/e2e suite, not covered by the in-memory fake above',
  );

  it('writes an OUTBOX_ENTRY for personnel.shift.claimed in the same transaction (PR #320 review, MAJOR)', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    await claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    const outboxPk = buildDeptScopedPk(DEPT_ID, 'OUTBOX', 'MBR-0012');
    const result = (await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :shiftPk',
        ExpressionAttributeValues: { ':shiftPk': outboxPk },
      }),
    )) as { Items?: Record<string, unknown>[] };
    expect(result.Items).toHaveLength(1);
    expect(result.Items?.[0]).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'personnel.shift.claimed',
      deptId: DEPT_ID,
      memberId: 'MBR-0012',
    });
  });

  it('returns NOT_FOUND for a shiftId/positionCode that does not exist', async () => {
    const doc = createFakeDocumentClient([]);

    const outcome = await claimShiftPosition(
      doc,
      TABLE,
      DEPT_ID,
      'no-such-shift',
      'DRIVER',
      'MBR-0012',
    );

    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });

  it('AC4: a resubmitted claim by the same member after their own success is idempotent (ALREADY_MINE), not a spurious conflict', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        claimedAt: 1_800_000_100,
      }),
    ]);

    const outcome = await claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'ALREADY_MINE', claimedAt: 1_800_000_100 });
  });

  it('AC4: a delayed offline resubmission that lost the race to a second claimant sees a conflict, never trusting the stale local claimed state', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0034',
        claimedAt: 1_800_000_200,
      }),
    ]);

    const outcome = await claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'CONFLICT' });
  });

  it('fails closed (not a silently dropped GSI) when DUTY_SHIFT metadata has no numeric startAt', async () => {
    const doc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: 'METADATA',
        entityType: 'DUTY_SHIFT',
        status: 'OPEN',
      },
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    await expect(
      claimShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
    ).rejects.toBeInstanceOf(ShiftPositionWriteError);
  });

  it('a non-conditional DynamoDB failure is not swallowed into a false success (fail-secure)', async () => {
    const failingDoc = {
      send: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as unknown as Parameters<typeof claimShiftPosition>[0];

    await expect(
      claimShiftPosition(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
    ).rejects.toBeInstanceOf(ShiftPositionWriteError);
  });

  it('the write error captures a reason that survives minified bundling (constructor.name, not error.name)', async () => {
    class CustomAwsError extends Error {}
    const failingDoc = {
      send: () => Promise.reject(new CustomAwsError('boom')),
    } as unknown as Parameters<typeof claimShiftPosition>[0];

    await expect(
      claimShiftPosition(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
    ).rejects.toMatchObject({ reason: 'CustomAwsError' });
  });

  it('never issues a batch write for the claim (it cannot carry a ConditionExpression)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./claimShiftPosition.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('BatchWriteItemCommand');
    expect(source).toContain('TransactWriteCommand');
  });
});
