import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { recalculateShiftStatus } from './recalculateShiftStatus.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

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
        if (name === 'UpdateCommand') {
          updateAttempts += 1;
          if (updateAttempts === 1) {
            return Promise.reject(
              new ConditionalCheckFailedException({
                message: 'lost the race to a concurrent claim',
                $metadata: {},
              }),
            );
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
        if (name === 'UpdateCommand') {
          return Promise.reject(
            new ConditionalCheckFailedException({
              message: 'always contended',
              $metadata: {},
            }),
          );
        }
        return send(command);
      },
    } as unknown as DynamoDBDocumentClient;

    await expect(
      recalculateShiftStatus(alwaysContendedDoc, TABLE, DEPT_ID, SHIFT_ID),
    ).rejects.toThrow(/exceeded 5 attempts/);
  });
});
