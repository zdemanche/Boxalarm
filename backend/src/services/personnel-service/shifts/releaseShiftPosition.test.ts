import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { releaseShiftPosition, ShiftPositionReleaseWriteError } from './releaseShiftPosition.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

describe('releaseShiftPosition', () => {
  it('AC1: clears claimedByMemberId/claimedAt/gsi1pk/gsi1sk via a conditional transactional write', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      {
        ...buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
          claimedByMemberId: 'MBR-0012',
          claimedAt: 1_800_000_100,
        }),
        gsi1pk: 'MEMBER#MBR-0012',
        gsi1sk: 'SHIFT_POSITION#1800000000',
      },
    ]);

    const outcome = await releaseShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'RELEASED' });
    const item = doc.peek(`DEPT#${DEPT_ID}#SHIFT#${SHIFT_ID}`, 'POSITION#DRIVER');
    expect(item?.claimedByMemberId).toBeUndefined();
    expect(item?.claimedAt).toBeUndefined();
    expect(item?.gsi1pk).toBeUndefined();
    expect(item?.gsi1sk).toBeUndefined();
  });

  it('AC1: writes an OUTBOX_ENTRY for personnel.shift.released in the same transaction', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
    ]);

    await releaseShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

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
      eventType: 'personnel.shift.released',
      deptId: DEPT_ID,
      memberId: 'MBR-0012',
    });
  });

  it('rejects release when not claimed by caller (NOT_CLAIMED_BY_YOU)', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0034' }),
    ]);

    const outcome = await releaseShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'NOT_CLAIMED_BY_YOU' });
    const item = doc.peek(`DEPT#${DEPT_ID}#SHIFT#${SHIFT_ID}`, 'POSITION#DRIVER');
    expect(item?.claimedByMemberId).toBe('MBR-0034');
  });

  it('returns NOT_FOUND for a positionCode that does not exist', async () => {
    const doc = createFakeDocumentClient([buildDutyShift(DEPT_ID, SHIFT_ID)]);

    const outcome = await releaseShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });

  it('rejects release when the position was never claimed (no claimedByMemberId to match)', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    const outcome = await releaseShiftPosition(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012');

    expect(outcome).toEqual({ kind: 'NOT_CLAIMED_BY_YOU' });
  });

  it('a non-conditional DynamoDB failure is not swallowed into a false success (fail-secure)', async () => {
    const failingDoc = {
      send: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as unknown as Parameters<typeof releaseShiftPosition>[0];

    await expect(
      releaseShiftPosition(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
    ).rejects.toBeInstanceOf(ShiftPositionReleaseWriteError);
  });

  it('re-throws a transient TransactionCanceledException (e.g. TransactionConflict) as ShiftPositionReleaseWriteError rather than a defaulted NOT_CLAIMED_BY_YOU', async () => {
    const failingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'TransactWriteCommand') {
          return Promise.reject(
            new TransactionCanceledException({
              message: 'Transaction cancelled',
              CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
              $metadata: {},
            }),
          );
        }
        return Promise.reject(new Error('unexpected command'));
      },
    } as unknown as Parameters<typeof releaseShiftPosition>[0];

    await expect(
      releaseShiftPosition(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012'),
    ).rejects.toBeInstanceOf(ShiftPositionReleaseWriteError);
  });

  it('never issues a batch write for the release (it cannot carry a ConditionExpression)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./releaseShiftPosition.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('BatchWriteItemCommand');
    expect(source).toContain('TransactWriteCommand');
  });
});
