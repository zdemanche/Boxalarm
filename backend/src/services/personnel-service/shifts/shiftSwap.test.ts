import { describe, expect, it } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  approveShiftSwap,
  getShiftSwapRequest,
  proposeShiftSwap,
  readShiftSwapConfig,
  ShiftSwapWriteError,
} from './shiftSwap.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

describe('readShiftSwapConfig', () => {
  it('defaults requiresOfficerApproval to true (fail-safe) when the DEPARTMENT_CONFIG item is absent', async () => {
    const doc = createFakeDocumentClient([]);

    const config = await readShiftSwapConfig(doc, TABLE, DEPT_ID);

    expect(config).toEqual({ requiresOfficerApproval: true });
  });

  it('defaults requiresOfficerApproval to true when the item exists but the flag is not a boolean', async () => {
    const doc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        entityType: 'DEPARTMENT_CONFIG',
        value: {},
      },
    ]);

    const config = await readShiftSwapConfig(doc, TABLE, DEPT_ID);

    expect(config).toEqual({ requiresOfficerApproval: true });
  });

  it('reads requiresOfficerApproval=false from the DEPARTMENT_CONFIG item value map (architecture.md:1297)', async () => {
    const doc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        entityType: 'DEPARTMENT_CONFIG',
        value: { requiresOfficerApproval: false },
        version: 1,
      },
    ]);

    const config = await readShiftSwapConfig(doc, TABLE, DEPT_ID);

    expect(config).toEqual({ requiresOfficerApproval: false });
  });

  it('defaults requiresOfficerApproval to true when the flag is set at the top level instead of inside value (legacy shape)', async () => {
    const doc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        entityType: 'DEPARTMENT_CONFIG',
        requiresOfficerApproval: false,
      },
    ]);

    const config = await readShiftSwapConfig(doc, TABLE, DEPT_ID);

    expect(config).toEqual({ requiresOfficerApproval: true });
  });
});

describe('proposeShiftSwap', () => {
  it('AC2: creates a PENDING SHIFT_SWAP_REQUEST carrying requiresOfficerApproval=true, no ownership change', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        value: { requiresOfficerApproval: true },
      },
    ]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE,
      DEPT_ID,
      SHIFT_ID,
      'DRIVER',
      'MBR-0012',
      'MBR-0034',
    );

    expect(outcome).toMatchObject({ kind: 'PROPOSED', requiresOfficerApproval: true });
    const requestedAt = (outcome as { requestedAt: number }).requestedAt;
    const swap = await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);
    expect(swap).toMatchObject({
      status: 'PENDING',
      fromMemberId: 'MBR-0012',
      toMemberId: 'MBR-0034',
    });
    const position = doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'POSITION#DRIVER');
    expect(position?.claimedByMemberId).toBe('MBR-0012');
  });

  it('AC3: creates a PENDING request carrying requiresOfficerApproval=false when department config disables it', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        value: { requiresOfficerApproval: false },
      },
    ]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE,
      DEPT_ID,
      SHIFT_ID,
      'DRIVER',
      'MBR-0012',
      'MBR-0034',
    );

    expect(outcome).toMatchObject({ kind: 'PROPOSED', requiresOfficerApproval: false });
  });

  it('rejects a swap proposed by a member who does not currently hold the position', async () => {
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0099' }),
    ]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE,
      DEPT_ID,
      SHIFT_ID,
      'DRIVER',
      'MBR-0012',
      'MBR-0034',
    );

    expect(outcome).toEqual({ kind: 'NOT_CLAIMED_BY_YOU' });
  });

  it('returns POSITION_NOT_FOUND for a positionCode that does not exist', async () => {
    const doc = createFakeDocumentClient([buildDutyShift(DEPT_ID, SHIFT_ID)]);

    const outcome = await proposeShiftSwap(
      doc,
      TABLE,
      DEPT_ID,
      SHIFT_ID,
      'DRIVER',
      'MBR-0012',
      'MBR-0034',
    );

    expect(outcome).toEqual({ kind: 'POSITION_NOT_FOUND' });
  });

  it('propagates a DynamoDB outage on the config read fail-closed (never a defaulted success)', async () => {
    const failingDoc = {
      send: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as unknown as Parameters<typeof proposeShiftSwap>[0];

    await expect(
      proposeShiftSwap(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012', 'MBR-0034'),
    ).rejects.toThrow('DynamoDB unavailable');
  });

  it('propagates a DynamoDB outage on the write as ShiftSwapWriteError (fail-secure) rather than a false outcome', async () => {
    const readOnlyDoc = createFakeDocumentClient([
      { pk: buildDeptScopedPk(DEPT_ID), sk: 'CONFIG#SHIFT_RULES', requiresOfficerApproval: true },
    ]);
    const failingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'GetCommand') {
          return (readOnlyDoc as unknown as { send: (c: unknown) => Promise<unknown> }).send(
            command,
          );
        }
        return Promise.reject(new Error('DynamoDB unavailable'));
      },
    } as unknown as Parameters<typeof proposeShiftSwap>[0];

    await expect(
      proposeShiftSwap(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012', 'MBR-0034'),
    ).rejects.toBeInstanceOf(ShiftSwapWriteError);
  });

  it('re-throws a transient TransactionCanceledException (e.g. TransactionConflict) as ShiftSwapWriteError rather than a defaulted NOT_CLAIMED_BY_YOU', async () => {
    const readOnlyDoc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#SHIFT_RULES',
        value: { requiresOfficerApproval: true },
      },
    ]);
    const failingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'GetCommand') {
          return (readOnlyDoc as unknown as { send: (c: unknown) => Promise<unknown> }).send(
            command,
          );
        }
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
    } as unknown as Parameters<typeof proposeShiftSwap>[0];

    await expect(
      proposeShiftSwap(failingDoc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012', 'MBR-0034'),
    ).rejects.toBeInstanceOf(ShiftSwapWriteError);
  });
});

describe('approveShiftSwap', () => {
  it('AC4: an officer approval records APPROVED and transfers claimedByMemberId to toMemberId', async () => {
    const requestedAt = 1_800_000_500;
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);

    expect(outcome).toEqual({ kind: 'APPROVED', toMemberId: 'MBR-0034' });
    const position = doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'POSITION#DRIVER');
    expect(position?.claimedByMemberId).toBe('MBR-0034');
    const swap = await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);
    expect(swap?.status).toBe('APPROVED');
  });

  it('AC3: a self-accept (no officer approval required) transfers claimedByMemberId directly', async () => {
    const requestedAt = 1_800_000_600;
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requiresOfficerApproval: false,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);

    expect(outcome).toEqual({ kind: 'APPROVED', toMemberId: 'MBR-0034' });
  });

  it('returns NOT_FOUND for a swapId that does not exist', async () => {
    const doc = createFakeDocumentClient([buildDutyShift(DEPT_ID, SHIFT_ID)]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, 1_800_000_700);

    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });

  it('rejects approve when the swap is already APPROVED (not PENDING)', async () => {
    const requestedAt = 1_800_000_800;
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0034' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'APPROVED',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);

    expect(outcome).toEqual({ kind: 'NOT_PENDING' });
  });

  it('rejects approve when position ownership changed since the swap was proposed (POSITION_CONFLICT)', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0099' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);

    expect(outcome).toEqual({ kind: 'POSITION_CONFLICT' });
  });

  it('propagates a DynamoDB outage as ShiftSwapWriteError (fail-secure) rather than a false outcome', async () => {
    const requestedAt = 1_800_001_000;
    const seed = [
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ];
    const readOnlyDoc = createFakeDocumentClient(seed);
    const failingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'GetCommand') {
          return (readOnlyDoc as unknown as { send: (c: unknown) => Promise<unknown> }).send(
            command,
          );
        }
        return Promise.reject(new Error('DynamoDB unavailable'));
      },
    } as unknown as Parameters<typeof approveShiftSwap>[0];

    await expect(
      approveShiftSwap(failingDoc, TABLE, DEPT_ID, SHIFT_ID, requestedAt),
    ).rejects.toBeInstanceOf(ShiftSwapWriteError);
  });

  it('re-throws a transient TransactionCanceledException (e.g. ThrottlingError) as ShiftSwapWriteError rather than a defaulted POSITION_CONFLICT', async () => {
    const requestedAt = 1_800_001_100;
    const seed = [
      buildDutyShift(DEPT_ID, SHIFT_ID),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requiresOfficerApproval: true,
        requestedAt,
      },
    ];
    const readOnlyDoc = createFakeDocumentClient(seed);
    const failingDoc = {
      send: (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'GetCommand') {
          return (readOnlyDoc as unknown as { send: (c: unknown) => Promise<unknown> }).send(
            command,
          );
        }
        if (name === 'TransactWriteCommand') {
          return Promise.reject(
            new TransactionCanceledException({
              message: 'Transaction cancelled',
              CancellationReasons: [
                { Code: 'None' },
                { Code: 'ThrottlingError' },
                { Code: 'None' },
              ],
              $metadata: {},
            }),
          );
        }
        return Promise.reject(new Error('unexpected command'));
      },
    } as unknown as Parameters<typeof approveShiftSwap>[0];

    await expect(
      approveShiftSwap(failingDoc, TABLE, DEPT_ID, SHIFT_ID, requestedAt),
    ).rejects.toBeInstanceOf(ShiftSwapWriteError);
  });
});

describe('getShiftSwapRequest', () => {
  it('returns undefined when no swap request exists at the given requestedAt', async () => {
    const doc = createFakeDocumentClient([]);

    const swap = await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, 1_800_001_100);

    expect(swap).toBeUndefined();
  });

  it('defaults requiresOfficerApproval to true (fail-secure) when the stored attribute is missing', async () => {
    const requestedAt = 1_800_001_200;
    const doc = createFakeDocumentClient([
      {
        pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID),
        sk: `SWAP#${requestedAt}`,
        entityType: 'SHIFT_SWAP_REQUEST',
        positionCode: 'DRIVER',
        fromMemberId: 'MBR-0012',
        toMemberId: 'MBR-0034',
        status: 'PENDING',
        requestedAt,
      },
    ]);

    const swap = await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt);

    expect(swap?.requiresOfficerApproval).toBe(true);
  });
});
