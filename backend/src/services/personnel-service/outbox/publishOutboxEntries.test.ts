import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';

function outboxRecord(
  memberId: string,
  eventId: string,
  overrides: Record<string, AttributeValue> = {},
): DynamoDBRecord {
  const newImage: Record<string, AttributeValue> = {
    entityType: { S: 'OUTBOX_ENTRY' },
    deptId: { S: 'NICHOLS' },
    memberId: { S: memberId },
    eventId: { S: eventId },
    eventTime: { S: '2026-09-14T00:00:00.000Z' },
    eventType: { S: 'personnel.member.updated' },
    source: { S: 'personnel-service' },
    correlationId: { S: memberId },
    schemaVersion: { S: '1.0' },
    payload: {
      M: { deptId: { S: 'NICHOLS' }, memberId: { S: memberId }, phone: { S: '555-0100' } },
    },
    ...overrides,
  };
  return {
    eventName: 'INSERT',
    dynamodb: { NewImage: newImage },
  };
}

function buildStreamEvent(records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

describe('publishOutboxEntries handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.PLATFORM_BUS_NAME = 'platform-bus';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('publishes a new outbox entry to EventBridge and marks it sent (AC3 chain)', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const ebSend = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const docSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    await handler(buildStreamEvent([outboxRecord('mbr-1', 'evt-1')]), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const ebCall = ebSend.mock.calls[0]?.[0] as {
      input: {
        Entries: Array<{
          Source: string;
          DetailType: string;
          EventBusName: string;
          Detail: string;
        }>;
      };
    };
    const putEventsInput = ebCall.input;
    expect(putEventsInput.Entries[0]?.Source).toBe('personnel-service');
    expect(putEventsInput.Entries[0]?.DetailType).toBe('personnel.member.updated');
    expect(putEventsInput.Entries[0]?.EventBusName).toBe('platform-bus');
    const detail = JSON.parse(putEventsInput.Entries[0]?.Detail ?? '{}') as {
      payload: { phone: string };
    };
    expect(detail.payload.phone).toBe('555-0100');

    expect(docSend).toHaveBeenCalledTimes(1);
    const docCall = docSend.mock.calls[0]?.[0] as { input: { Key: { pk: string; sk: string } } };
    expect(docCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#OUTBOX#mbr-1', sk: 'EVT#evt-1' });
  });

  it('batches up to 10 entries per PutEvents call and issues more than one call for a larger batch (regression: P1)', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const ebSend = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const docSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    const records = Array.from({ length: 12 }, (_, i) => outboxRecord(`mbr-${i}`, `evt-${i}`));
    await handler(buildStreamEvent(records), {} as never, () => undefined);

    expect(ebSend).toHaveBeenCalledTimes(2);
    const firstBatch = (ebSend.mock.calls[0]?.[0] as { input: { Entries: unknown[] } }).input
      .Entries;
    const secondBatch = (ebSend.mock.calls[1]?.[0] as { input: { Entries: unknown[] } }).input
      .Entries;
    expect(firstBatch).toHaveLength(10);
    expect(secondBatch).toHaveLength(2);
    expect(docSend).toHaveBeenCalledTimes(12);
  });

  it('marks all succeeded entries sent even when PutEvents reports a per-entry failure, and rethrows (regression: P2)', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ebSend = vi.fn().mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [
        { EventId: 'ok-1' },
        { ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' },
      ],
    });
    const docSend = vi.fn().mockResolvedValue({});
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    await expect(
      handler(
        buildStreamEvent([outboxRecord('mbr-1', 'evt-1'), outboxRecord('mbr-2', 'evt-2')]),
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow('1 of 2 entries failed');

    expect(docSend).toHaveBeenCalledTimes(1);
    const docCall = docSend.mock.calls[0]?.[0] as { input: { Key: { pk: string; sk: string } } };
    expect(docCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#OUTBOX#mbr-1', sk: 'EVT#evt-1' });
    expect(
      errorSpy.mock.calls.some((call) =>
        (call[0] as string).includes('personnel.outbox.publish.entryFailed'),
      ),
    ).toBe(true);

    errorSpy.mockRestore();
  });

  it('treats an already-sent mark as success rather than failing the batch (regression: P5)', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const ebSend = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    const docSend = vi
      .fn()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: 'already sent', $metadata: {} }),
      );
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    await expect(
      handler(buildStreamEvent([outboxRecord('mbr-1', 'evt-1')]), {} as never, () => undefined),
    ).resolves.toBeUndefined();
  });

  it('skips a record whose entityType is not OUTBOX_ENTRY or that is already marked sent', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const ebSend = vi.fn();
    const docSend = vi.fn();
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    const nonOutbox = outboxRecord('mbr-1', 'evt-1', { entityType: { S: 'MEMBER' } });
    const alreadySent = outboxRecord('mbr-2', 'evt-2', { sentAt: { N: '1700000000000' } });

    await handler(buildStreamEvent([nonOutbox, alreadySent]), {} as never, () => undefined);

    expect(ebSend).not.toHaveBeenCalled();
    expect(docSend).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows (fail-closed to DLQ) when EventBridge PutEvents fails', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ebSend = vi.fn().mockRejectedValue(new Error('EventBridge unavailable'));
    const docSend = vi.fn();
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    await expect(
      handler(buildStreamEvent([outboxRecord('mbr-1', 'evt-1')]), {} as never, () => undefined),
    ).rejects.toThrow('EventBridge unavailable');

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as { message: string };
    expect(logged.message).toBe('EventBridge unavailable');
    expect(docSend).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some((call) => (call[0] as string).includes('OutboxEntryPublishFailed')),
    ).toBe(true);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('rethrows on a malformed record missing required envelope fields', async () => {
    const { createHandler } = await import('./publishOutboxEntries.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ebSend = vi.fn();
    const docSend = vi.fn();
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    const malformed: DynamoDBRecord = {
      eventName: 'INSERT',
      dynamodb: {
        NewImage: {
          entityType: { S: 'OUTBOX_ENTRY' },
          deptId: { S: 'NICHOLS' },
          memberId: { S: 'mbr-1' },
        },
      },
    };

    await expect(
      handler(buildStreamEvent([malformed]), {} as never, () => undefined),
    ).rejects.toThrow();
    expect(ebSend).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('throws when PLATFORM_BUS_NAME is unset, before any AWS call (misconfigured deployment)', async () => {
    delete process.env.PLATFORM_BUS_NAME;
    const { createHandler } = await import('./publishOutboxEntries.js');
    const ebSend = vi.fn();
    const docSend = vi.fn();
    const handler = createHandler({
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      docClient: { send: docSend } as unknown as DynamoDBDocumentClient,
    });

    await expect(
      handler(buildStreamEvent([outboxRecord('mbr-1', 'evt-1')]), {} as never, () => undefined),
    ).rejects.toThrow('PLATFORM_BUS_NAME is required and was not set');
    expect(ebSend).not.toHaveBeenCalled();
    expect(docSend).not.toHaveBeenCalled();
  });

  it('exercises the exported handler (entrypoint test) with an empty batch', async () => {
    const { handler } = await import('./publishOutboxEntries.js');
    await expect(
      handler(buildStreamEvent([]), {} as never, () => undefined),
    ).resolves.toBeUndefined();
  });
});
