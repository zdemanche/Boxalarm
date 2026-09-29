import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

vi.mock('../escalation/scheduleEscalation.js', () => ({
  createEscalationSchedule: vi.fn().mockResolvedValue('esc-schedule'),
}));

vi.mock('../escalation/toneLadder.js', () => ({
  scheduleDepartmentToneLadder: vi.fn().mockResolvedValue(undefined),
}));

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

interface SentUpdate {
  readonly Key: { pk: string; sk: string };
  readonly UpdateExpression: string;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

function createFakeDdb(): { send: DynamoDBDocumentClient['send']; updates: SentUpdate[] } {
  const updates: SentUpdate[] = [];
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    if (name !== 'UpdateCommand') {
      throw new Error(`fanOut.test fake ddb: unexpected ${name}`);
    }
    updates.push((command as { input: SentUpdate }).input);
    return Promise.resolve({});
  });
  return { send, updates };
}

describe('scheduleRealtimeFanOutEscalation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('seeds a roster row per member and never writes a delivery receipt', async () => {
    const { scheduleRealtimeFanOutEscalation } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await scheduleRealtimeFanOutEscalation(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      [
        { memberId: 'mbr-1', quals: ['INTERIOR'] },
        { memberId: 'mbr-2', quals: [] },
      ],
    );

    expect(fakeDdb.updates.map((update) => update.Key.sk)).toEqual([
      'ROSTER#mbr-1',
      'ROSTER#mbr-2',
    ]);
    expect(fakeDdb.updates[0]?.ExpressionAttributeValues).toMatchObject({
      ':rosterEntityType': 'DISPATCH_ROSTER_ENTRY',
      ':rosterQuals': ['INTERIOR'],
      ':rosterNone': 'NONE',
      ':rosterPrimary': 'primary',
      ':rosterZero': 0,
    });
  });

  // Review MAJOR-1: a member may answer before this runs. Every field is seeded only where
  // absent, with no condition, so an existing answer is kept and the row still gets the
  // currentChannelTier / escalationLevel the escalation handler needs.
  it('seeds each field with if_not_exists and no condition, so an earlier answer survives', async () => {
    const { scheduleRealtimeFanOutEscalation } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await scheduleRealtimeFanOutEscalation(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      [{ memberId: 'mbr-1', quals: [] }],
    );

    const update = fakeDdb.updates[0]!;
    expect(update.ConditionExpression).toBeUndefined();
    for (const field of ['quals', 'ackStatus', 'currentChannelTier', 'escalationLevel']) {
      expect(update.UpdateExpression).toContain(`${field} = if_not_exists(${field},`);
    }
  });

  it('creates a tone-1 escalation schedule per member and the department tone ladder once', async () => {
    const { createEscalationSchedule } = await import('../escalation/scheduleEscalation.js');
    const { scheduleDepartmentToneLadder } = await import('../escalation/toneLadder.js');
    const { scheduleRealtimeFanOutEscalation } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await scheduleRealtimeFanOutEscalation(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      [
        { memberId: 'mbr-1', quals: [] },
        { memberId: 'mbr-2', quals: [] },
      ],
    );

    expect(createEscalationSchedule).toHaveBeenCalledTimes(2);
    expect(createEscalationSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatchId: 'dispatch-1', memberId: 'mbr-1', toneSequence: 1 }),
      expect.anything(),
      'alerting-table',
    );
    expect(scheduleDepartmentToneLadder).toHaveBeenCalledTimes(1);
  });

  it('schedules no tone ladder for an empty audience', async () => {
    const { scheduleDepartmentToneLadder } = await import('../escalation/toneLadder.js');
    const { scheduleRealtimeFanOutEscalation } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb();

    await scheduleRealtimeFanOutEscalation(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      [],
    );

    expect(scheduleDepartmentToneLadder).not.toHaveBeenCalled();
  });
});
