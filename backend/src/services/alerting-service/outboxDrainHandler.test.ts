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
  eventType: 'dispatch.alert.received',
  source: 'alerting-service',
  correlationId: 'NICHOLS-MANUAL-1798000000-abcd1234',
  schemaVersion: '1.0',
  payload: { dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234', incidentType: 'STRUCTURE_FIRE' },
};

describe('alerting-service outboxDrainHandler (bridge)', () => {
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

  it('bridges a dispatch.alert.received OUTBOX_ENTRY to the platform bus with source alerting-service', async () => {
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
    expect(entry?.Source).toBe('alerting-service');
    expect(entry?.DetailType).toBe('dispatch.alert.received');
    const detail = JSON.parse(entry?.Detail as string) as Record<string, unknown>;
    expect(detail.eventId).toBe('evt-1');
    expect(detail.correlationId).toBe('NICHOLS-MANUAL-1798000000-abcd1234');
  });

  it('skips a stream record whose entityType is not OUTBOX_ENTRY, publishing nothing', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockResolvedValue({});
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord({ entityType: 'DISPATCH_ALERT' }, 'seq-1')]),
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('reports batchItemFailures instead of rejecting on EventBridge PutEvents failure', async () => {
    const { createOutboxDrainHandler } = await import('./outboxDrainHandler.js');
    const send = vi.fn().mockRejectedValue(new Error('EventBridge unavailable'));
    const handler = createOutboxDrainHandler(fakeClient(send));
    const result = await (handler as StreamHandler)(
      streamEvent([outboxRecord(OUTBOX_ITEM, 'seq-1')]),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
  });
});
