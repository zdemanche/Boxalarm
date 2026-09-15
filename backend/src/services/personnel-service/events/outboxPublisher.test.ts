import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';

const eventBridgeSend = vi.fn();
const docSend = vi.fn();

vi.mock('../awsClients.js', () => ({
  readPersonnelServiceConfig: vi.fn(() => ({
    tableName: 'personnel-table',
    busName: 'platform-bus',
  })),
  createDynamoDocClient: vi.fn(() => ({ send: docSend })),
  createEventBridgeClient: vi.fn(() => ({ send: eventBridgeSend })),
}));

import { handler } from './outboxPublisher.js';

const envelope = {
  eventId: 'evt-1',
  eventTime: '2026-09-14T00:00:00.000Z',
  eventType: 'personnel.eligibility.changed',
  source: 'personnel-service',
  correlationId: 'corr-1',
  schemaVersion: '1.0',
  payload: { deptId: 'NICHOLS', memberId: 'MBR-0012', qualCode: 'INTERIOR' },
};

function outboxInsertRecord(
  overrides: Record<string, unknown> = {},
): DynamoDBStreamEvent['Records'][number] {
  return {
    eventID: 'rec-1',
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: 'seq-1',
      NewImage: marshall({
        pk: 'DEPT#NICHOLS#MEMBER#MBR-0012',
        sk: 'OUTBOX#outbox-1',
        entityType: 'OUTBOX',
        eventType: 'personnel.eligibility.changed',
        sent: false,
        envelope,
        ...overrides,
      }),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handler (outboxPublisher entrypoint)', () => {
  it('publishes to EventBridge and marks the OUTBOX row sent on success', async () => {
    eventBridgeSend.mockResolvedValue({});
    docSend.mockResolvedValue({});

    const result = await handler({ Records: [outboxInsertRecord()] }, {} as never, () => undefined);

    expect(eventBridgeSend).toHaveBeenCalledTimes(1);
    const putEventsCommand = eventBridgeSend.mock.calls[0]?.[0] as {
      input: { Entries: { DetailType: string; EventBusName: string }[] };
    };
    expect(putEventsCommand.input.Entries[0]?.DetailType).toBe('personnel.eligibility.changed');
    expect(putEventsCommand.input.Entries[0]?.EventBusName).toBe('platform-bus');

    expect(docSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('adds the record to batchItemFailures and leaves it unsent when EventBridge publish fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    eventBridgeSend.mockRejectedValue(new Error('EventBridge unavailable'));

    const result = await handler({ Records: [outboxInsertRecord()] }, {} as never, () => undefined);

    expect(docSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('personnel.outbox.publish.failed'),
    );
  });

  it('treats a partial PutEvents failure (FailedEntryCount > 0) as a failure and does not mark the row sent (P4)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    eventBridgeSend.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'boom' }],
    });

    const result = await handler({ Records: [outboxInsertRecord()] }, {} as never, () => undefined);

    expect(docSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'seq-1' }] });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('personnel.outbox.publish.failed'),
    );
  });

  it('skips an already-sent record without publishing', async () => {
    const record = outboxInsertRecord({ sent: true });
    const result = await handler({ Records: [record] }, {} as never, () => undefined);

    expect(eventBridgeSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a non-INSERT stream record (e.g. the sent=true MODIFY) without publishing', async () => {
    const record = {
      ...outboxInsertRecord(),
      eventName: 'MODIFY',
    } as DynamoDBStreamEvent['Records'][number];
    const result = await handler({ Records: [record] }, {} as never, () => undefined);

    expect(eventBridgeSend).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });
});
