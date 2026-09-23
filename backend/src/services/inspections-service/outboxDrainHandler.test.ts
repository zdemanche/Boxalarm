import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

type LambdaNewImage = NonNullable<NonNullable<DynamoDBRecord['dynamodb']>['NewImage']>;
type StreamHandler = (e: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;

function fakeClient(send: (command: unknown) => Promise<unknown>): EventBridgeClient {
  return { send } as unknown as EventBridgeClient;
}

function streamEvent(records: DynamoDBStreamEvent['Records']): DynamoDBStreamEvent {
  return { Records: records };
}

function newImage(item: Record<string, unknown>): LambdaNewImage {
  return marshall(item) as unknown as LambdaNewImage;
}

function outboxRecord(
  item: Record<string, unknown>,
  sequenceNumber: string,
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE' = 'INSERT',
): DynamoDBRecord {
  return {
    eventName,
    dynamodb: { NewImage: newImage(item), SequenceNumber: sequenceNumber },
  };
}

const OUTBOX_ITEM = {
  entityType: 'OUTBOX_ENTRY',
  eventId: 'evt-1',
  eventTime: '2026-09-14T00:00:00.000Z',
  eventType: 'inspections.preplan.updated',
  source: 'inspections-service',
  correlationId: 'PP-1',
  schemaVersion: '1.0',
  payload: { occupancyId: 'OCC-1', prePlanId: 'PP-1' },
};

describe('outboxDrainHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws before any AWS call when PLATFORM_EVENT_BUS_NAME is not set (entrypoint test)', async () => {
    delete process.env.PLATFORM_EVENT_BUS_NAME;
    const { handler } = await import('./outboxDrainHandler.js');
    await expect((handler as StreamHandler)(streamEvent([]))).rejects.toThrow(
      'PLATFORM_EVENT_BUS_NAME is required and was not set',
    );
  });

  it('publishes an INSERT of an OUTBOX_ENTRY to EventBridge as the pre-plan-updated event (AC4)', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
    const command = send.mock.calls[0]?.[0] as {
      input: { Entries: Array<Record<string, unknown>> };
    };
    const entry = command.input.Entries[0];
    expect(entry?.EventBusName).toBe('boxalarm-dev-platform-bus');
    expect(entry?.DetailType).toBe('inspections.preplan.updated');
    const detail = JSON.parse(entry?.Detail as string) as Record<string, unknown>;
    expect(detail.eventId).toBe('evt-1');
    expect(detail.correlationId).toBe('PP-1');
  });

  it('skips a stream record whose entityType is not OUTBOX_ENTRY, publishing nothing', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord({ entityType: 'PRE_PLAN' }, 'seq-1')]),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a MODIFY/REMOVE record even when it carries an OUTBOX_ENTRY image', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1', 'MODIFY')]),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('reports batchItemFailures instead of rejecting on EventBridge PutEvents failure, so only the failing chunk onward retries (core-harm)', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockRejectedValue(new Error('EventBridge unavailable'));
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
  });

  it('reports batchItemFailures when PutEvents resolves 200 with a partial FailedEntryCount rather than acking a lost publish', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' }],
    });
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
  });

  it('batches more than 10 outbox records into multiple PutEvents calls of at most 10 entries', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler(fakeClient(send));
    const records = Array.from({ length: 12 }, (_, i) =>
      outboxRecord({ ...OUTBOX_ITEM, eventId: `evt-${i}`, correlationId: `PP-${i}` }, `seq-${i}`),
    );
    const result = await (handler as StreamHandler)(streamEvent(records));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [] });
    const firstCall = send.mock.calls[0]?.[0] as { input: { Entries: unknown[] } };
    const secondCall = send.mock.calls[1]?.[0] as { input: { Entries: unknown[] } };
    expect(firstCall.input.Entries).toHaveLength(10);
    expect(secondCall.input.Entries).toHaveLength(2);
  });

  it('does not retry a chunk that already succeeded when a later chunk fails (mixed-batch partial failure)', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('EventBridge unavailable'));
    const handler = createOutboxDrainHandler(fakeClient(send));
    const records = Array.from({ length: 12 }, (_, i) =>
      outboxRecord({ ...OUTBOX_ITEM, eventId: `evt-${i}`, correlationId: `PP-${i}` }, `seq-${i}`),
    );
    const result = await (handler as StreamHandler)(streamEvent(records));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-10' }] });
  });
});
