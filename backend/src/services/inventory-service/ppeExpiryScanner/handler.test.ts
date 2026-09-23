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
  process.env.PLATFORM_CONFIG_DYNAMO_TABLE_NAME = 'platform-config';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.PPE_SCANNER_DEPT_ID = 'NICHOLS';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

function dueItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ppeItemId: 'TURNOUT-COAT',
    memberId: 'MBR-1',
    nfpaExpiryDate: '2026-09-20',
    ...overrides,
  };
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

describe('runPpeExpiryScan (core-harm: exactly one publish, no false negatives/positives)', () => {
  it('publishes exactly one ppe.expiry.due event for a PPE item within the lead-time window (AC2)', async () => {
    const { runPpeExpiryScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { ppeExpiryLeadDays: 30 } },
      currentMonthItems: [dueItem({ nfpaExpiryDate: '2026-09-20' })],
    });
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runPpeExpiryScan('trace-1', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
  });

  it('publishes no event for a PPE item outside the lead-time window', async () => {
    const { runPpeExpiryScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { ppeExpiryLeadDays: 5 } },
      currentMonthItems: [dueItem({ nfpaExpiryDate: '2026-09-30' })],
    });
    const ebSend = vi.fn();

    await runPpeExpiryScan('trace-2', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('publishes no event on a same-day re-run for an item already flagged (AC2 dedup guard)', async () => {
    const { runPpeExpiryScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { ppeExpiryLeadDays: 30 } },
      currentMonthItems: [dueItem({ nfpaExpiryDate: '2026-09-20' })],
      dedupConflict: true,
    });
    const ebSend = vi.fn();

    await runPpeExpiryScan('trace-3', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('completes with zero publishes and no error when nothing is due (empty scan window)', async () => {
    const { runPpeExpiryScan } = await import('./handler.js');
    const send = ddbSend({ leadDaysItem: { value: { ppeExpiryLeadDays: 30 } } });
    const ebSend = vi.fn();

    await expect(
      runPpeExpiryScan('trace-4', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).resolves.toBeUndefined();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is unset', async () => {
    delete process.env.PLATFORM_EVENT_BUS_NAME;
    const { runPpeExpiryScan } = await import('./handler.js');
    const send = ddbSend({
      leadDaysItem: { value: { ppeExpiryLeadDays: 30 } },
      currentMonthItems: [dueItem({ nfpaExpiryDate: '2026-09-20' })],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runPpeExpiryScan('trace-5', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: vi.fn() } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    errorSpy.mockRestore();
  });

  it('logs the original error and rethrows (fail-closed) when the GSI2 query fails', async () => {
    const { runPpeExpiryScan } = await import('./handler.js');
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: { value: { ppeExpiryLeadDays: 30 } } };
      }
      throw failure;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runPpeExpiryScan('trace-6', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: vi.fn() } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'ppeExpiryScanner.scan.failed');
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
  vi.doMock('../lifecycle/repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lifecycle/repository.js')>();
    return {
      ...actual,
      createInventoryDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
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
  it('reads PPE_SCANNER_DEPT_ID from the ScheduledEvent trigger and publishes the due item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const ddbCalls = ddbSend({
      leadDaysItem: { value: { ppeExpiryLeadDays: 30 } },
      currentMonthItems: [dueItem({ nfpaExpiryDate: '2026-09-20' })],
    });
    mockDynamoModule(ddbCalls);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });
    mockEventBridgeModule(ebSend);

    const { handler } = await import('./handler.js');
    await handler(scheduledEvent('sched-entrypoint'), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as { input: { Entries: { DetailType: string }[] } };
    expect(putEvents.input.Entries[0]?.DetailType).toBe('ppe.expiry.due');
  });

  it('throws (fail-closed) when PPE_SCANNER_DEPT_ID is not set', async () => {
    delete process.env.PPE_SCANNER_DEPT_ID;
    mockDynamoModule(vi.fn());
    mockEventBridgeModule(vi.fn());
    const { handler } = await import('./handler.js');

    await expect(
      handler(scheduledEvent('sched-missing-config'), {} as never, () => undefined),
    ).rejects.toThrow('PPE_SCANNER_DEPT_ID');
  });
});
