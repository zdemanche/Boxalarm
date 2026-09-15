import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { ScheduledEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-service';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.APPARATUS_TEST_SCANNER_DEPT_ID = 'NICHOLS';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

function dueTestItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { gsi2sk: '2026-09-20#APP-ENGINE-2#HOSE', ...overrides };
}

interface DdbBehavior {
  readonly leadDaysItem?: Record<string, unknown>;
  readonly currentMonthItems?: Record<string, unknown>[];
  readonly nextMonthItems?: Record<string, unknown>[];
  readonly dedupConflict?: boolean;
}

function ddbSend(behavior: DdbBehavior): ReturnType<typeof vi.fn> {
  return vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      return { Item: behavior.leadDaysItem };
    }
    if (command instanceof QueryCommand) {
      const gsi2pk = command.input.ExpressionAttributeValues?.[':gsi2pk'] as string;
      return gsi2pk.endsWith('2026-09')
        ? { Items: behavior.currentMonthItems ?? [] }
        : { Items: behavior.nextMonthItems ?? [] };
    }
    if (command instanceof PutCommand) {
      if (behavior.dedupConflict) {
        throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
      }
      return {};
    }
    if (command instanceof UpdateCommand) {
      return {};
    }
    throw new Error(`unexpected command: ${String(command)}`);
  });
}

const NOW = new Date('2026-09-14T02:00:00Z');

describe('runApparatusTestDueScan (core-harm: exactly one publish, no false negatives/positives)', () => {
  it('publishes exactly one apparatus.test.due event for a test within the lead-time window (AC2)', async () => {
    const { runApparatusTestDueScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { apparatusTestLeadDays: 30 } },
      currentMonthItems: [dueTestItem()],
    });
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runApparatusTestDueScan('trace-1', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
  });

  it('publishes no event for a test outside the lead-time window', async () => {
    const { runApparatusTestDueScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { apparatusTestLeadDays: 5 } },
      currentMonthItems: [dueTestItem({ gsi2sk: '2026-09-30#APP-ENGINE-2#HOSE' })],
    });
    const ebSend = vi.fn();

    await runApparatusTestDueScan('trace-2', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('publishes no event on a same-day re-run for a test already flagged (AC2 dedup guard)', async () => {
    const { runApparatusTestDueScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { apparatusTestLeadDays: 30 } },
      currentMonthItems: [dueTestItem()],
      dedupConflict: true,
    });
    const ebSend = vi.fn();

    await runApparatusTestDueScan('trace-3', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('falls back to the default lead time and still scans when no config is set', async () => {
    const { runApparatusTestDueScan } = await import('./handler.js');
    const send = ddbSend({
      currentMonthItems: [dueTestItem({ gsi2sk: '2026-10-05#APP-ENGINE-2#HOSE' })],
    });
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runApparatusTestDueScan('trace-4', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
  });

  it('logs the original error and rethrows (fail-closed) when the GSI2 query fails', async () => {
    const { runApparatusTestDueScan } = await import('./handler.js');
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: { value: { apparatusTestLeadDays: 30 } } };
      }
      throw failure;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runApparatusTestDueScan('trace-6', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: vi.fn() } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'testDueScanner.scan.failed');
    expect(logged?.correlationId).toBe('trace-6');
    errorSpy.mockRestore();
  });
});

function scheduledEvent(id = 'sched-1'): ScheduledEvent {
  return {
    id,
    version: '0',
    account: '111122223333',
    time: '2026-09-14T02:00:00Z',
    region: 'us-east-1',
    resources: [],
    source: 'aws.scheduler',
    'detail-type': 'Scheduled Event',
    detail: {},
  } as ScheduledEvent;
}

function mockDynamoModule(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return {
      ...actual,
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
    };
  });
}

function mockEventBridgeModule(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('./publishDueEvents.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./publishDueEvents.js')>();
    return {
      ...actual,
      createEventBridgeClient: () => ({ send }) as unknown as EventBridgeClient,
    };
  });
}

describe('handler (entrypoint-test obligation — the exported Lambda handler, not just the pure functions)', () => {
  it('reads APPARATUS_TEST_SCANNER_DEPT_ID from the ScheduledEvent trigger and publishes the due test', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const ddbCalls = ddbSend({
      leadDaysItem: { value: { apparatusTestLeadDays: 30 } },
      currentMonthItems: [dueTestItem()],
    });
    mockDynamoModule(ddbCalls);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });
    mockEventBridgeModule(ebSend);

    const { handler } = await import('./handler.js');
    await handler(scheduledEvent('sched-entrypoint'), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as { input: { Entries: { DetailType: string }[] } };
    expect(putEvents.input.Entries[0]?.DetailType).toBe('apparatus.test.due');
  });

  it('throws (fail-closed) when APPARATUS_TEST_SCANNER_DEPT_ID is not set', async () => {
    delete process.env.APPARATUS_TEST_SCANNER_DEPT_ID;
    mockDynamoModule(vi.fn());
    mockEventBridgeModule(vi.fn());
    const { handler } = await import('./handler.js');

    await expect(
      handler(scheduledEvent('sched-missing-config'), {} as never, () => undefined),
    ).rejects.toThrow('APPARATUS_TEST_SCANNER_DEPT_ID');
  });
});
