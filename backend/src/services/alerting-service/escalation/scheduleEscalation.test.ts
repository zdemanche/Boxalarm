import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('readEscalationThresholdSeconds', () => {
  it('falls back to the 75s default when ALERT_RULES_COPY is absent', async () => {
    const { readEscalationThresholdSeconds } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({ Item: undefined });

    const threshold = await readEscalationThresholdSeconds(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );

    expect(threshold).toBe(75);
  });

  it('uses the department-configured escalationThresholdSeconds when present (AC4)', async () => {
    const { readEscalationThresholdSeconds } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({
      Item: { toneLadder: { escalationThresholdSeconds: 45 } },
    });

    const threshold = await readEscalationThresholdSeconds(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );

    expect(threshold).toBe(45);
  });

  it('falls back to the default when escalationThresholdSeconds is wrong-typed', async () => {
    const { readEscalationThresholdSeconds } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({
      Item: { toneLadder: { escalationThresholdSeconds: '45' } },
    });

    const threshold = await readEscalationThresholdSeconds(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );

    expect(threshold).toBe(75);
  });
});

describe('createEscalationSchedule', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a schedule with the expected name and payload shape (AC4)', async () => {
    const { createEscalationSchedule } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({});

    await createEscalationSchedule({ send } as unknown as SchedulerClient, {
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 1,
      delaySeconds: 75,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    const { escalationScheduleName } = await import('./scheduleEscalation.js');
    expect(command.input.Name).toBe(escalationScheduleName('NICHOLS', 'dispatch-1', 'mbr-1', 1));
    // IAM scopes CreateSchedule to schedule/<dedicated group>/* — omitting GroupName
    // lands the schedule in `default` and is denied.
    expect(command.input.GroupName).toBe('boxalarm-dev-alerting-escalation');
    const target = command.input.Target as { Input: string };
    expect(JSON.parse(target.Input)).toEqual({
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 1,
      channel: 'voice',
    });
  });

  // Post-merge: one-time timers delete themselves after firing and dead-letter a target the
  // scheduler gave up on, instead of piling up in the group or vanishing.
  it('deletes the schedule after it fires and dead-letters a failed target to the configured DLQ', async () => {
    process.env.ESCALATION_SCHEDULE_DLQ_ARN =
      'arn:aws:sqs:us-east-1:1:boxalarm-dev-alerting-schedule-dlq';
    const { createEscalationSchedule } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({});

    await createEscalationSchedule({ send } as unknown as SchedulerClient, {
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 2,
      delaySeconds: 75,
    });

    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect(input.Target).toMatchObject({
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:1:boxalarm-dev-alerting-schedule-dlq' },
    });
  });

  it('still creates the schedule (without a DLQ) when ESCALATION_SCHEDULE_DLQ_ARN is unset, and says so', async () => {
    delete process.env.ESCALATION_SCHEDULE_DLQ_ARN;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { createEscalationSchedule } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({});

    await createEscalationSchedule({ send } as unknown as SchedulerClient, {
      deptId: DEPT_ID,
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 1,
      delaySeconds: 75,
    });

    const input = (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect((input.Target as Record<string, unknown>).DeadLetterConfig).toBeUndefined();
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('dlq_unconfigured'))).toBe(
      true,
    );
    logSpy.mockRestore();
  });

  it('a re-create after the schedule deleted itself is absorbed by name conflict or by the idempotent target', async () => {
    const { createEscalationSchedule } = await import('./scheduleEscalation.js');
    const conflict = Object.assign(new Error('exists'), { name: 'ConflictException' });
    const send = vi.fn().mockRejectedValue(conflict);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      createEscalationSchedule({ send } as unknown as SchedulerClient, {
        deptId: DEPT_ID,
        dispatchId: 'dispatch-1',
        memberId: 'mbr-1',
        toneSequence: 1,
        delaySeconds: 75,
      }),
    ).resolves.toMatch(/^esc-1-/);
    logSpy.mockRestore();
  });

  it('fails loudly when ESCALATION_SCHEDULE_GROUP_NAME is unset instead of creating in `default`', async () => {
    delete process.env.ESCALATION_SCHEDULE_GROUP_NAME;
    const { createEscalationSchedule } = await import('./scheduleEscalation.js');
    const send = vi.fn().mockResolvedValue({});

    await expect(
      createEscalationSchedule({ send } as unknown as SchedulerClient, {
        deptId: DEPT_ID,
        dispatchId: 'dispatch-1',
        memberId: 'mbr-1',
        toneSequence: 1,
        delaySeconds: 75,
      }),
    ).rejects.toThrow('ESCALATION_SCHEDULE_GROUP_NAME is required');
    expect(send).not.toHaveBeenCalled();
  });
});
