import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'boxalarm-platform';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.INVENTORY_REORDER_SCANNER_DEPT_ID = 'NICHOLS';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function consumableItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#CONSUMABLE#GLOVES-L',
    sk: 'METADATA',
    entityType: 'CONSUMABLE_STOCK',
    itemName: 'Gloves (Large)',
    stockLevel: 3,
    reorderThreshold: 5,
    ...overrides,
  };
}

interface DdbBehavior {
  readonly belowThresholdItems?: Record<string, unknown>[];
  readonly dedupConflict?: boolean;
}

function ddbSend(behavior: DdbBehavior): ReturnType<typeof vi.fn> {
  return vi.fn((command: unknown) => {
    if (command instanceof QueryCommand) {
      return { Items: behavior.belowThresholdItems ?? [] };
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

describe('runConsumableReorderScan (core-harm: a below-threshold item always publishes)', () => {
  it('AC2: publishes inventory.reorder.due for each below-threshold item', async () => {
    const { runConsumableReorderScan } = await import('./handler.js');
    const send = ddbSend({ belowThresholdItems: [consumableItem()] });
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runConsumableReorderScan('trace-1', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as { input: { Entries: { DetailType: string }[] } };
    expect(putEvents.input.Entries[0]?.DetailType).toBe('inventory.reorder.due');
  });

  it('AC3: a restocked item (above threshold) produces no event, because it is excluded from the query itself', async () => {
    const { runConsumableReorderScan } = await import('./handler.js');
    const send = ddbSend({ belowThresholdItems: [] });
    const ebSend = vi.fn();

    await runConsumableReorderScan('trace-2', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('publishes no duplicate event on a same-day re-run for an already-flagged item (AC2 dedup guard)', async () => {
    const { runConsumableReorderScan } = await import('./handler.js');
    const send = ddbSend({ belowThresholdItems: [consumableItem()], dedupConflict: true });
    const ebSend = vi.fn();

    await runConsumableReorderScan('trace-3', {
      dynamoClient: { send } as unknown as DynamoDBDocumentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now: NOW,
    });

    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows, emitting ScanFailed (fail-closed) when the query fails', async () => {
    const { runConsumableReorderScan } = await import('./handler.js');
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn(() => {
      throw failure;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      runConsumableReorderScan('trace-4', {
        dynamoClient: { send } as unknown as DynamoDBDocumentClient,
        eventBridgeClient: { send: vi.fn() } as unknown as EventBridgeClient,
        now: NOW,
      }),
    ).rejects.toBe(failure);

    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'consumableReorderScanner.scan.failed');
    expect(logged?.correlationId).toBe('trace-4');
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
  vi.doMock('../lib/dynamoDb.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/dynamoDb.js')>();
    return {
      ...actual,
      getDocClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
    };
  });
}

describe('handler (entrypoint-test obligation — the exported Lambda handler, not just the pure functions)', () => {
  it('reads INVENTORY_REORDER_SCANNER_DEPT_ID from the ScheduledEvent trigger and publishes for below-threshold items', async () => {
    const ddbCalls = ddbSend({ belowThresholdItems: [consumableItem()] });
    mockDynamoModule(ddbCalls);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    const { handler, createEventBridgeClient } = await import('./handler.js');
    createEventBridgeClient({ send: ebSend } as unknown as EventBridgeClient);
    await handler(scheduledEvent('sched-entrypoint'), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(1);
  });

  it('throws (fail-closed) when INVENTORY_REORDER_SCANNER_DEPT_ID is not set', async () => {
    delete process.env.INVENTORY_REORDER_SCANNER_DEPT_ID;
    mockDynamoModule(vi.fn());
    const { handler, createEventBridgeClient } = await import('./handler.js');
    createEventBridgeClient({ send: vi.fn() } as unknown as EventBridgeClient);

    await expect(
      handler(scheduledEvent('sched-missing-config'), {} as never, () => undefined),
    ).rejects.toThrow('INVENTORY_REORDER_SCANNER_DEPT_ID');
  });
});

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const PUBLISH_TABLE = 'boxalarm-platform';
const publishEnv = { PLATFORM_EVENT_BUS_NAME: 'boxalarm-test-platform-bus' };

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function fakeEb(send: ReturnType<typeof vi.fn>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

const basePublishParams = {
  deptId,
  itemId: 'GLOVES-L',
  itemName: 'Gloves (Large)',
  currentQty: 3,
  reorderThreshold: 5,
  correlationId: 'trace-1',
  now: new Date('2026-09-14T12:00:00Z'),
};

describe('publishReorderDueEvent', () => {
  it('writes the dedup marker, publishes exactly one well-formed inventory.reorder.due event, then marks it published (AC2, contract)', async () => {
    const { publishReorderDueEvent } = await import('./handler.js');
    const ddbSend = vi.fn().mockResolvedValue({});
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{ EventId: 'evt-1' }] });
    const ddb = fakeDdb(ddbSend);
    const eb = fakeEb(ebSend);

    const outcome = await publishReorderDueEvent(
      ddb,
      eb,
      publishEnv,
      PUBLISH_TABLE,
      basePublishParams,
    );

    expect(outcome).toBe('Published');
    const putCommand = ddbSend.mock.calls[0]?.[0] as PutCommand;
    expect(putCommand).toBeInstanceOf(PutCommand);
    expect(putCommand.input.Item?.pk).toBe('DEPT#NICHOLS#CONSUMABLE_REORDER_FLAG#2026-09-14');
    expect(putCommand.input.Item?.sk).toBe('CONSUMABLE#GLOVES-L');

    const updateCommand = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCommand).toBeInstanceOf(UpdateCommand);
    expect(updateCommand.input.ConditionExpression).toBe('attribute_exists(pk)');

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putEvents).toBeInstanceOf(PutEventsCommand);
    const entry = putEvents.input.Entries?.[0];
    expect(entry?.EventBusName).toBe('boxalarm-test-platform-bus');
    expect(entry?.DetailType).toBe('inventory.reorder.due');
    const detail = JSON.parse(entry?.Detail ?? '{}') as Record<string, unknown>;
    expect(detail.eventType).toBe('inventory.reorder.due');
    expect(detail.source).toBe('inventory-service');
    expect(detail.correlationId).toBe('trace-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      itemId: 'GLOVES-L',
      itemName: 'Gloves (Large)',
      currentQty: 3,
      reorderThreshold: 5,
      deptId: 'NICHOLS',
    });
  });

  it('AC3: skips publish and no-ops when the item was already flagged today (restocked-then-redropped re-run guard)', async () => {
    const { publishReorderDueEvent } = await import('./handler.js');
    const ddbSend = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const ebSend = vi.fn();

    const outcome = await publishReorderDueEvent(
      fakeDdb(ddbSend),
      fakeEb(ebSend),
      publishEnv,
      PUBLISH_TABLE,
      basePublishParams,
    );

    expect(outcome).toBe('SkippedDuplicate');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows (fail-closed) when EventBridge PutEvents fails, leaving the marker unpublished', async () => {
    const { publishReorderDueEvent } = await import('./handler.js');
    const ddbSend = vi.fn().mockResolvedValue({});
    const publishFailure = new Error('EventBridge unavailable');
    const ebSend = vi.fn().mockRejectedValue(publishFailure);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishReorderDueEvent(
        fakeDdb(ddbSend),
        fakeEb(ebSend),
        publishEnv,
        PUBLISH_TABLE,
        basePublishParams,
      ),
    ).rejects.toBe(publishFailure);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry.event === 'consumableReorderScanner.publish.failed');
    expect(logged?.correlationId).toBe('trace-1');
    errorSpy.mockRestore();
  });

  it('throws (fail-closed) when PLATFORM_EVENT_BUS_NAME is not set', async () => {
    const { publishReorderDueEvent } = await import('./handler.js');
    const ddbSend = vi.fn();
    const ebSend = vi.fn();

    await expect(
      publishReorderDueEvent(
        fakeDdb(ddbSend),
        fakeEb(ebSend),
        {},
        PUBLISH_TABLE,
        basePublishParams,
      ),
    ).rejects.toThrow('PLATFORM_EVENT_BUS_NAME');
    expect(ddbSend).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });
});
