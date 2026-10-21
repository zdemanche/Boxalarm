import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { recalculateShiftStatus } from './recalculateShiftStatus.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

function contendedTransaction(message: string): TransactionCanceledException {
  return new TransactionCanceledException({
    message,
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    $metadata: {},
  });
}

describe('recalculateShiftStatus', () => {
  it('AC3: recalculates to FULL when every position is claimed', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'OFFICER', { claimedByMemberId: 'MBR-0034' }),
    ]);

    const outcome = await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

    expect(outcome).toEqual({ kind: 'UPDATED', status: 'FULL' });
  });

  it('AC3: recalculates to PARTIALLY_FILLED when only some positions are claimed', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'OFFICER'),
    ]);

    const outcome = await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

    expect(outcome).toEqual({ kind: 'UPDATED', status: 'PARTIALLY_FILLED' });
  });

  it('recalculates to OPEN when no positions are claimed', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
    ]);

    const outcome = await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

    expect(outcome).toEqual({ kind: 'UPDATED', status: 'OPEN' });
  });

  it('never overwrites a CANCELLED shift status', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID, { status: 'CANCELLED' }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
    ]);

    const outcome = await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

    expect(outcome).toEqual({ kind: 'SKIPPED_CANCELLED' });
  });

  it('returns NOT_FOUND when the shift does not exist', async () => {
    const doc = createFakeDocumentClient([]);

    const outcome = await recalculateShiftStatus(doc, TABLE, DEPT_ID, 'no-such-shift');

    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });

  it('reads the shift with ConsistentRead so a just-written claim is never missed', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
    ]);
    const send = (doc as unknown as { send: (command: unknown) => Promise<unknown> }).send;
    const seenConsistentRead: unknown[] = [];
    const spyingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'QueryCommand') {
          seenConsistentRead.push(
            (command as { input: { ConsistentRead?: boolean } }).input.ConsistentRead,
          );
        }
        return send(command);
      },
    } as unknown as DynamoDBDocumentClient;

    await recalculateShiftStatus(spyingDoc, TABLE, DEPT_ID, SHIFT_ID);

    expect(seenConsistentRead).toEqual([true]);
  });

  it('retries against a fresh consistent read when a concurrent writer wins the version-conditioned update (no lost update)', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'OFFICER', { claimedByMemberId: 'MBR-0034' }),
    ]);
    const send = (doc as unknown as { send: (command: unknown) => Promise<unknown> }).send;
    let updateAttempts = 0;
    const contendedDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'TransactWriteCommand') {
          updateAttempts += 1;
          if (updateAttempts === 1) {
            return Promise.reject(contendedTransaction('lost the race to a concurrent claim'));
          }
        }
        return send(command);
      },
    } as unknown as DynamoDBDocumentClient;

    const outcome = await recalculateShiftStatus(contendedDoc, TABLE, DEPT_ID, SHIFT_ID);

    expect(outcome).toEqual({ kind: 'UPDATED', status: 'FULL' });
    expect(updateAttempts).toBe(2);
  });

  it('throws (fails closed) rather than silently giving up when a concurrent writer contends on every attempt', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
    ]);
    const send = (doc as unknown as { send: (command: unknown) => Promise<unknown> }).send;
    const alwaysContendedDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'TransactWriteCommand') {
          return Promise.reject(contendedTransaction('always contended'));
        }
        return send(command);
      },
    } as unknown as DynamoDBDocumentClient;

    await expect(
      recalculateShiftStatus(alwaysContendedDoc, TABLE, DEPT_ID, SHIFT_ID),
    ).rejects.toThrow(/exceeded 5 attempts/);
  });

  describe('coverage-gap outbox events', () => {
    function outboxEvents(doc: ReturnType<typeof createFakeDocumentClient>) {
      return [...doc.all()].filter((item) => item.entityType === 'OUTBOX_ENTRY');
    }

    it('emits scheduling.coverage_gap.detected with the unclaimed required quals and shift end when a position is unclaimed', async () => {
      const doc = createFakeDocumentClient([
        buildDutyShift(DEPT_ID, SHIFT_ID),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'OFFICER', { requiredQual: 'OFFICER_QUAL' }),
      ]);

      await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

      const events = outboxEvents(doc);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'scheduling.coverage_gap.detected',
        source: 'personnel-service',
        payload: {
          deptId: 'NICHOLS',
          shiftId: SHIFT_ID,
          gapReason: 'short',
          requiredQuals: ['OFFICER_QUAL'],
          endAt: 1_800_028_800,
        },
      });
    });

    it('emits scheduling.coverage_gap.resolved when the last open position is claimed', async () => {
      const doc = createFakeDocumentClient([
        buildDutyShift(DEPT_ID, SHIFT_ID),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      ]);

      await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

      expect(outboxEvents(doc)).toMatchObject([
        {
          eventType: 'scheduling.coverage_gap.resolved',
          payload: { deptId: 'NICHOLS', shiftId: SHIFT_ID },
        },
      ]);
    });

    it('does not advance the shift status when the outbox write fails (status and event commit together)', async () => {
      const doc = createFakeDocumentClient([
        buildDutyShift(DEPT_ID, SHIFT_ID),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
      ]);
      const send = (doc as unknown as { send: (command: unknown) => Promise<unknown> }).send;
      const outboxFailingDoc = {
        send: (command: unknown) => {
          const name = (command as { constructor: { name: string } }).constructor.name;
          if (name === 'PutCommand') {
            return Promise.reject(new Error('outbox put throttled'));
          }
          if (name === 'TransactWriteCommand') {
            return Promise.reject(
              Object.assign(new Error('outbox put throttled'), { name: 'ThrottlingException' }),
            );
          }
          return send(command);
        },
      } as unknown as DynamoDBDocumentClient;

      await expect(
        recalculateShiftStatus(outboxFailingDoc, TABLE, DEPT_ID, SHIFT_ID),
      ).rejects.toThrow(/outbox put throttled/);

      expect(
        doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'METADATA')?.version,
      ).toBeUndefined();
      expect(outboxEvents(doc)).toEqual([]);
    });

    it('emits nothing for a cancelled shift', async () => {
      const doc = createFakeDocumentClient([
        buildDutyShift(DEPT_ID, SHIFT_ID, { status: 'CANCELLED' }),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER'),
      ]);

      await recalculateShiftStatus(doc, TABLE, DEPT_ID, SHIFT_ID);

      expect(outboxEvents(doc)).toEqual([]);
    });
  });
});
