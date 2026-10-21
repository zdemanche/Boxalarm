import { describe, expect, it, vi } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  approveShiftSwap,
  getShiftSwapRequest,
  listPendingShiftSwaps,
  proposeShiftSwap,
  readShiftSwapConfig,
  ShiftSwapWriteError,
} from './shiftSwap.js';
import { createFakeDocumentClient } from './testDynamoFake.js';
import { buildDutyShift, buildMemberQualification, buildShiftPosition } from './testFixtures.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'personnel-table';
const SHIFT_ID = 'SHIFT-0511';

function openShift(overrides: { startAt?: number; endAt?: number; status?: string } = {}) {
  const now = Date.now();
  return buildDutyShift(DEPT_ID, SHIFT_ID, {
    startAt: now - 3_600_000,
    endAt: now + 3_600_000,
    ...overrides,
  });
}

function pendingSwap(requestedAt: number, shiftId = SHIFT_ID) {
  return {
    pk: buildDeptScopedPk(DEPT_ID, 'SHIFT', shiftId),
    sk: `SWAP#${requestedAt}`,
    entityType: 'SHIFT_SWAP_REQUEST',
    positionCode: 'DRIVER',
    fromMemberId: 'MBR-0012',
    toMemberId: 'MBR-0034',
    status: 'PENDING',
    requiresOfficerApproval: true,
    requestedAt,
  };
}

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
      openShift(),
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
      openShift(),
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
      openShift(),
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
    const doc = createFakeDocumentClient([openShift()]);

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
      openShift(),
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
      openShift(),
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
    const doc = createFakeDocumentClient([openShift()]);

    const outcome = await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, 1_800_000_700);

    expect(outcome).toEqual({ kind: 'NOT_FOUND' });
  });

  it('rejects approve when the swap is already APPROVED (not PENDING)', async () => {
    const requestedAt = 1_800_000_800;
    const doc = createFakeDocumentClient([
      openShift(),
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
      openShift(),
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
      openShift(),
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
      openShift(),
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

describe('shift swap review fixes', () => {
  it('B1-087: a POSITION_CONFLICT approve marks the swap DENIED so it leaves the pending queue', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      openShift(),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0099' }),
      pendingSwap(requestedAt),
    ]);

    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'POSITION_CONFLICT',
    });
    expect((await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt))?.status).toBe(
      'DENIED',
    );
    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'NOT_PENDING',
    });
  });

  it('B1-087: a swap proposed before the position was released and reclaimed by the proposer cannot be approved', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      openShift(),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        claimedAt: requestedAt + 5_000,
      }),
      pendingSwap(requestedAt),
    ]);

    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'POSITION_CONFLICT',
    });
    expect(
      doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'POSITION#DRIVER')?.claimedByMemberId,
    ).toBe('MBR-0012');
  });

  it('B1-021: approving a swap to a member without the required qualification returns NOT_QUALIFIED and moves nothing', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      openShift(),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        requiredQual: 'DRIVER_OPERATOR',
      }),
      pendingSwap(requestedAt),
    ]);

    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'NOT_QUALIFIED',
      requiredQual: 'DRIVER_OPERATOR',
    });
    expect(
      doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'POSITION#DRIVER')?.claimedByMemberId,
    ).toBe('MBR-0012');
  });

  it('B1-021: approving a swap to a qualified member succeeds', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      openShift(),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', {
        claimedByMemberId: 'MBR-0012',
        requiredQual: 'DRIVER_OPERATOR',
      }),
      buildMemberQualification(DEPT_ID, 'MBR-0034', 'DRIVER_OPERATOR'),
      pendingSwap(requestedAt),
    ]);

    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'APPROVED',
      toMemberId: 'MBR-0034',
    });
  });

  it('B1-074: lists pending swaps on upcoming shifts only', async () => {
    const now = Date.now();
    const doc = createFakeDocumentClient([
      buildDutyShift(DEPT_ID, 'SHIFT-NEXT', { startAt: now, endAt: now + 3_600_000 }),
      pendingSwap(1, 'SHIFT-NEXT'),
      buildDutyShift(DEPT_ID, 'SHIFT-PAST', { startAt: now - 7_200_000, endAt: now - 3_600_000 }),
      pendingSwap(2, 'SHIFT-PAST'),
      buildDutyShift(DEPT_ID, 'SHIFT-CANCELLED', {
        startAt: now,
        endAt: now + 3_600_000,
        status: 'CANCELLED',
      }),
      pendingSwap(3, 'SHIFT-CANCELLED'),
    ]);
    const sendSpy = vi.spyOn(doc, 'send');

    const swaps = await listPendingShiftSwaps(doc, TABLE, DEPT_ID);

    expect(swaps.map((swap) => swap.shiftId)).toEqual(['SHIFT-NEXT']);
    const queriedPartitions = (sendSpy.mock.calls as unknown as [unknown][])
      .map(([command]) => command)
      .filter((command): command is { input: unknown } => command instanceof QueryCommand)
      .map((command) => JSON.stringify(command.input));
    expect(queriedPartitions.some((values) => values.includes('SHIFT-PAST'))).toBe(false);
    expect(queriedPartitions.some((values) => values.includes('SHIFT-CANCELLED'))).toBe(false);
  });

  it.each([
    ['ended', { startAt: Date.now() - 9 * 3_600_000, endAt: Date.now() - 3_600_000 }],
    ['cancelled', { status: 'CANCELLED' }],
  ])(
    'B1-018: approving a swap on an %s shift returns SHIFT_CLOSED and moves nothing',
    async (_label, overrides) => {
      const requestedAt = 1_800_000_900;
      const doc = createFakeDocumentClient([
        openShift(overrides),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
        pendingSwap(requestedAt),
      ]);

      expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
        kind: 'SHIFT_CLOSED',
      });
      expect(
        doc.peek(buildDeptScopedPk(DEPT_ID, 'SHIFT', SHIFT_ID), 'POSITION#DRIVER')
          ?.claimedByMemberId,
      ).toBe('MBR-0012');
      expect((await getShiftSwapRequest(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt))?.status).toBe(
        'PENDING',
      );
    },
  );

  it.each([
    ['ended', { startAt: Date.now() - 9 * 3_600_000, endAt: Date.now() - 3_600_000 }],
    ['cancelled', { status: 'CANCELLED' }],
  ])(
    'B1-018: proposing a swap on an %s shift returns SHIFT_CLOSED and writes nothing',
    async (_label, overrides) => {
      const doc = createFakeDocumentClient([
        openShift(overrides),
        buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0012' }),
      ]);

      expect(
        await proposeShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, 'DRIVER', 'MBR-0012', 'MBR-0034'),
      ).toEqual({ kind: 'SHIFT_CLOSED' });
      expect([...doc.all()].filter((item) => String(item.sk).startsWith('SWAP#'))).toHaveLength(0);
    },
  );

  it('B1-087: a failing DENIED write does not turn a position conflict into an error', async () => {
    const requestedAt = 1_800_000_900;
    const doc = createFakeDocumentClient([
      openShift(),
      buildShiftPosition(DEPT_ID, SHIFT_ID, 'DRIVER', { claimedByMemberId: 'MBR-0099' }),
      pendingSwap(requestedAt),
    ]);
    const realSend = doc.send.bind(doc);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(doc, 'send').mockImplementation(((command: { constructor: { name: string } }) =>
      command.constructor.name === 'UpdateCommand'
        ? Promise.reject(new Error('throttled'))
        : realSend(command as never)) as never);

    expect(await approveShiftSwap(doc, TABLE, DEPT_ID, SHIFT_ID, requestedAt)).toEqual({
      kind: 'POSITION_CONFLICT',
    });
  });
});
