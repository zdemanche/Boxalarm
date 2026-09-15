import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { ScheduledEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.APPARATUS_SCANNER_DEPT_ID = 'NICHOLS';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

function scbaItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scbaUnitId: 'SCBA-001',
    apparatusId: 'ENGINE-2',
    cylinderId: 'CYL-0891',
    flowTestDate: '2026-01-01',
    hydroTestDate: '2026-06-01',
    nextFlowTestDue: '2026-09-20',
    nextHydroTestDue: '2030-12-31',
    gsi2sk: '2026-09-20#SCBA-001',
    ...overrides,
  };
}

interface DdbBehavior {
  readonly currentMonthItems?: Record<string, unknown>[];
  readonly dedupConflict?: boolean;
}

function ddbSend(behavior: DdbBehavior): ReturnType<typeof vi.fn> {
  return vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues?.[':pk'] as string;
      return Promise.resolve(
        pk.endsWith('2026-09') ? { Items: behavior.currentMonthItems ?? [] } : { Items: [] },
      );
    }
    if (command instanceof PutCommand) {
      if (behavior.dedupConflict) {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      return Promise.resolve({});
    }
    if (command instanceof UpdateCommand) {
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected command: ${String(command)}`));
  });
}

const NOW = new Date('2026-09-14T02:00:00Z');

describe('runApparatusTestingScan (AC3: emits apparatus.test.due for a due SCBA test)', () => {
  it('publishes exactly one apparatus.test.due event for a test within the lead-time window', async () => {
    const { runApparatusTestingScan } = await import('./handler.js');
    const send = ddbSend({ currentMonthItems: [scbaItem()] });
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runApparatusTestingScan('trace-1', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as { input: { Entries: { Detail: string }[] } };
    const detail = JSON.parse(putEvents.input.Entries[0]?.Detail ?? '{}') as {
      payload: { testType: string; scbaUnitId: string };
    };
    expect(detail.payload.testType).toBe('SCBA_FLOW');
    expect(detail.payload.scbaUnitId).toBe('SCBA-001');
  });

  it('publishes no event when neither test date is within the lead-time window', async () => {
    const { runApparatusTestingScan } = await import('./handler.js');
    const send = ddbSend({
      currentMonthItems: [
        scbaItem({ nextFlowTestDue: '2026-12-01', nextHydroTestDue: '2031-01-01' }),
      ],
    });
    const ebSend = vi.fn();

    await runApparatusTestingScan('trace-2', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('publishes no event on a same-day re-run for a test already flagged (dedup guard)', async () => {
    const { runApparatusTestingScan } = await import('./handler.js');
    const send = ddbSend({ currentMonthItems: [scbaItem()], dedupConflict: true });
    const ebSend = vi.fn();

    await runApparatusTestingScan('trace-3', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('completes with no publishes and no error when no records are due (no-op)', async () => {
    const { runApparatusTestingScan } = await import('./handler.js');
    const send = ddbSend({});
    const ebSend = vi.fn();

    await expect(
      runApparatusTestingScan('trace-4', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).resolves.toBeUndefined();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows (fail-closed) when the GSI2 query fails', async () => {
    const { runApparatusTestingScan } = await import('./handler.js');
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runApparatusTestingScan('trace-5', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: vi.fn() } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'apparatusTestingScanner.scan.failed');
    expect(logged?.correlationId).toBe('trace-5');
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
  it('reads APPARATUS_SCANNER_DEPT_ID from the ScheduledEvent trigger and publishes the due test', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const ddbCalls = ddbSend({ currentMonthItems: [scbaItem()] });
    mockDynamoModule(ddbCalls);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });
    mockEventBridgeModule(ebSend);

    const { handler } = await import('./handler.js');
    await handler(scheduledEvent('sched-entrypoint'), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as { input: { Entries: { DetailType: string }[] } };
    expect(putEvents.input.Entries[0]?.DetailType).toBe('apparatus.test.due');
  });

  it('throws (fail-closed) when APPARATUS_SCANNER_DEPT_ID is not set', async () => {
    delete process.env.APPARATUS_SCANNER_DEPT_ID;
    mockDynamoModule(vi.fn());
    mockEventBridgeModule(vi.fn());
    const { handler } = await import('./handler.js');

    await expect(
      handler(scheduledEvent('sched-missing-config'), {} as never, () => undefined),
    ).rejects.toThrow('APPARATUS_SCANNER_DEPT_ID');
  });
});
