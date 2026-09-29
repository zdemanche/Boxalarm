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

function createFakeDdb(existingRosterMembers: readonly string[] = []): {
  send: DynamoDBDocumentClient['send'];
  puts: Record<string, unknown>[];
} {
  const puts: Record<string, unknown>[] = [];
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: { Item: Record<string, unknown> } }).input;
    if (name !== 'PutCommand') {
      throw new Error(`fanOut.test fake ddb: unexpected ${name}`);
    }
    if (existingRosterMembers.includes(input.Item.memberId as string)) {
      const error = new Error('conditional check failed');
      error.name = 'ConditionalCheckFailedException';
      throw error;
    }
    puts.push(input.Item);
    return Promise.resolve({});
  });
  return { send, puts };
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

  it('writes a roster entry per member and never a delivery receipt (receipts are the stream fan-out producer`s alone)', async () => {
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

    expect(fakeDdb.puts.map((item) => item.sk)).toEqual(['ROSTER#mbr-1', 'ROSTER#mbr-2']);
    expect(fakeDdb.puts.some((item) => item.entityType === 'DELIVERY_RECEIPT')).toBe(false);
    expect(fakeDdb.puts[0]).toMatchObject({
      entityType: 'DISPATCH_ROSTER_ENTRY',
      quals: ['INTERIOR'],
      ackStatus: 'NONE',
      currentChannelTier: 'primary',
    });
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

  it('keeps an existing roster entry (a retried fan-out must not reset an ack) and still schedules', async () => {
    const { createEscalationSchedule } = await import('../escalation/scheduleEscalation.js');
    const { scheduleRealtimeFanOutEscalation } = await import('./fanOut.js');
    const fakeDdb = createFakeDdb(['mbr-1']);

    await scheduleRealtimeFanOutEscalation(
      { send: fakeDdb.send } as unknown as DynamoDBDocumentClient,
      { send: vi.fn() } as unknown as SchedulerClient,
      'alerting-table',
      DEPT_ID,
      'dispatch-1',
      [{ memberId: 'mbr-1', quals: [] }],
    );

    expect(fakeDdb.puts).toEqual([]);
    expect(createEscalationSchedule).toHaveBeenCalledTimes(1);
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
