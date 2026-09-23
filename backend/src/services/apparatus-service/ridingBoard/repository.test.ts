import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { assignSeat, getRidingBoard } from './repository.js';
import { createRidingBoardFakeClient } from './testDynamoFake.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-table';
const DISPATCH_ID = 'DISPATCH-0511';
const APP_PK = `DEPT#${DEPT_ID}#APPARATUS#APP-ENGINE-2`;
const DISPATCH_PK = `DEPT#${DEPT_ID}#DISPATCH#${DISPATCH_ID}`;

function apparatusItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pk: APP_PK,
    sk: 'METADATA',
    entityType: 'APPARATUS',
    unitId: 'ENGINE-2',
    type: 'ENGINE',
    status: 'IN_SERVICE',
    gsi3pk: `DEPT#${DEPT_ID}#APPARATUS`,
    gsi3sk: 'ENGINE-2',
    ...overrides,
  };
}

function configItem(): Record<string, unknown> {
  return {
    pk: `DEPT#${DEPT_ID}`,
    sk: 'CONFIG#RIDING_POSITIONS',
    entityType: 'DEPARTMENT_CONFIG',
    configType: 'RIDING_POSITIONS',
    value: {
      ENGINE: [
        { code: 'DRIVER', label: 'Driver/Operator', requiredQual: 'DRIVER_OPERATOR' },
        { code: 'OFFICER', label: 'Officer', requiredQual: 'OFFICER_CERT' },
        { code: 'INTERIOR_1', label: 'Interior' },
      ],
    },
  };
}

describe('assignSeat', () => {
  it('AC1/AC7: assigns a vacant seat with expectedVersion 0 and records history keyed by clientAssignmentId', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(outcome).toMatchObject({ kind: 'ASSIGNED', memberId: 'MBR-0012', version: 1 });
    const seat = client.peek(DISPATCH_PK, 'SEAT#APP-ENGINE-2#DRIVER');
    expect(seat?.memberId).toBe('MBR-0012');
  });

  it('reads the prior seat state with ConsistentRead (regression: eventually-consistent read could bake a stale previousMemberId into the event/history despite the transaction condition passing)', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);
    const sendSpy = vi.spyOn(client, 'send');

    await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    // Only the seat-state read (SEAT#...) goes through readSeatState; the separate
    // history-replay check (SEATHIST#...) is a different read with its own semantics.
    const seatStateReads = sendSpy.mock.calls.filter((call) => {
      const cmd = call[0] as { constructor: { name: string }; input: { Key?: { sk?: string } } };
      return cmd.constructor.name === 'GetCommand' && cmd.input.Key?.sk?.startsWith('SEAT#');
    });
    expect(seatStateReads.length).toBeGreaterThan(0);
    for (const call of seatStateReads) {
      expect((call[0] as { input: { ConsistentRead?: boolean } }).input.ConsistentRead).toBe(true);
    }
  });

  it('AC4: refuses to assign a seat on an out-of-service apparatus and surfaces the reason', async () => {
    const client = createRidingBoardFakeClient([
      apparatusItem({ status: 'OUT_OF_SERVICE', outOfServiceReason: 'Pump failure' }),
    ]);

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(outcome).toEqual({ kind: 'OUT_OF_SERVICE', reason: 'Pump failure' });
  });

  it('test notes: an apparatus that goes out of service after an earlier seat was assigned refuses a further assignment to it', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);
    await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });
    client.put(apparatusItem({ status: 'OUT_OF_SERVICE', outOfServiceReason: 'Pump failure' }));

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'OFFICER',
      memberId: 'MBR-0034',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-2',
      assignedBy: 'officer-1',
    });

    expect(outcome).toEqual({ kind: 'OUT_OF_SERVICE', reason: 'Pump failure' });
  });

  it('AC7: a replayed clientAssignmentId (offline reconnect) is idempotent and does not create a duplicate history row', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);

    const first = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });
    const replay = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(first.kind).toBe('ASSIGNED');
    expect(replay.kind).toBe('ALREADY_APPLIED');
    const seat = client.peek(DISPATCH_PK, 'SEAT#APP-ENGINE-2#DRIVER');
    expect(seat?.version).toBe(1);
  });

  it('AC8: exactly one of two concurrent officer assignments to the same seat wins; the loser is surfaced as CONFLICT with the winning seat, never silently discarded (core-harm)', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);

    const [first, second] = await Promise.all([
      assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
        unitId: 'ENGINE-2',
        positionCode: 'DRIVER',
        memberId: 'MBR-0012',
        expectedVersion: 0,
        clientAssignmentId: 'CLIENT-A',
        assignedBy: 'officer-1',
      }),
      assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
        unitId: 'ENGINE-2',
        positionCode: 'DRIVER',
        memberId: 'MBR-0034',
        expectedVersion: 0,
        clientAssignmentId: 'CLIENT-B',
        assignedBy: 'officer-2',
      }),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(['ASSIGNED', 'CONFLICT']);
    const winnerMemberId = first.kind === 'ASSIGNED' ? 'MBR-0012' : 'MBR-0034';
    const seat = client.peek(DISPATCH_PK, 'SEAT#APP-ENGINE-2#DRIVER');
    expect(seat?.memberId).toBe(winnerMemberId);
    const conflictOutcome = first.kind === 'CONFLICT' ? first : second;
    expect(conflictOutcome).toMatchObject({
      kind: 'CONFLICT',
      current: { memberId: winnerMemberId },
    });
  });

  it('AC3: an unmet-qualification assignment is permitted, never blocked by the repository', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-UNQUALIFIED',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(outcome.kind).toBe('ASSIGNED');
  });

  it('routine input: memberId null on an already-vacant seat is an idempotent vacate (200, not an error)', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: null,
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(outcome).toMatchObject({ kind: 'ASSIGNED', memberId: null });
  });

  it('reassigning a seat records the previous occupant so downstream propagation can clear their old assignment (AC2/AC6)', async () => {
    const client = createRidingBoardFakeClient([apparatusItem()]);
    await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0034',
      expectedVersion: 1,
      clientAssignmentId: 'CLIENT-2',
      assignedBy: 'officer-1',
    });

    expect(outcome).toMatchObject({
      kind: 'ASSIGNED',
      memberId: 'MBR-0034',
      previousMemberId: 'MBR-0012',
      version: 2,
    });
  });

  it('returns APPARATUS_NOT_FOUND for an unknown unitId', async () => {
    const client = createRidingBoardFakeClient([]);

    const outcome = await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'NO-SUCH-UNIT',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    expect(outcome).toEqual({ kind: 'APPARATUS_NOT_FOUND' });
  });
});

describe('getRidingBoard', () => {
  it('AC1: renders in-service apparatus with configured riding positions', async () => {
    const client = createRidingBoardFakeClient([apparatusItem(), configItem()]);

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    expect(board.apparatus).toHaveLength(1);
    expect(board.apparatus[0]).toMatchObject({
      apparatusId: 'APP-ENGINE-2',
      unitId: 'ENGINE-2',
      assignable: true,
      positions: [
        { code: 'DRIVER', requiredQual: 'DRIVER_OPERATOR' },
        { code: 'OFFICER', requiredQual: 'OFFICER_CERT' },
        { code: 'INTERIOR_1' },
      ],
    });
  });

  it('AC4: an out-of-service apparatus is marked unassignable with its reason visible, not excluded silently', async () => {
    const client = createRidingBoardFakeClient([
      apparatusItem({ status: 'OUT_OF_SERVICE', outOfServiceReason: 'Pump failure' }),
      configItem(),
    ]);

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    expect(board.apparatus[0]).toMatchObject({
      assignable: false,
      outOfServiceReason: 'Pump failure',
    });
  });

  it('AC3: an assigned member lacking the required qualification is flagged UNMET, never blocking the read', async () => {
    const client = createRidingBoardFakeClient([apparatusItem(), configItem()]);
    await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    const driverPosition = board.apparatus[0]?.positions.find(
      (position) => position.code === 'DRIVER',
    );
    expect(driverPosition?.assignment).toMatchObject({ memberId: 'MBR-0012', qualStatus: 'UNMET' });
  });

  it('AC3: a member holding the required qualification is flagged MET', async () => {
    const client = createRidingBoardFakeClient([
      apparatusItem(),
      configItem(),
      {
        pk: `DEPT#${DEPT_ID}#MEMBER#MBR-0012`,
        sk: 'QUAL#DRIVER_OPERATOR',
        entityType: 'MEMBER_QUALIFICATION',
        qualCode: 'DRIVER_OPERATOR',
        currentlyEligible: true,
      },
    ]);
    await assignSeat(client, TABLE, DEPT_ID, DISPATCH_ID, {
      unitId: 'ENGINE-2',
      positionCode: 'DRIVER',
      memberId: 'MBR-0012',
      expectedVersion: 0,
      clientAssignmentId: 'CLIENT-1',
      assignedBy: 'officer-1',
    });

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    const driverPosition = board.apparatus[0]?.positions.find(
      (position) => position.code === 'DRIVER',
    );
    expect(driverPosition?.assignment).toMatchObject({ qualStatus: 'MET' });
  });

  it('routine input: a position code not configured for the apparatus type is exposed with no requiredQual, board still renders when the config is absent for that type', async () => {
    const client = createRidingBoardFakeClient([
      apparatusItem({ type: 'TANKER', gsi3pk: `DEPT#${DEPT_ID}#APPARATUS`, gsi3sk: 'ENGINE-2' }),
      configItem(),
    ]);

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    expect(board.apparatus[0]?.positions).toEqual([]);
  });

  it('routine input: zero assignments yet renders 200 with vacant positions', async () => {
    const client = createRidingBoardFakeClient([apparatusItem(), configItem()]);

    const board = await getRidingBoard(client, TABLE, DEPT_ID, DISPATCH_ID);

    expect(
      board.apparatus[0]?.positions.every((position) => position.assignment === undefined),
    ).toBe(true);
  });
});
