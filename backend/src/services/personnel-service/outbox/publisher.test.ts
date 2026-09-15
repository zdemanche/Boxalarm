import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBStreamEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_TABLE_NAME = 'platform-table';
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function outboxRecord(
  overrides: Record<string, unknown> = {},
): DynamoDBStreamEvent['Records'][number] {
  return {
    eventName: 'INSERT',
    dynamodb: {
      NewImage: {
        pk: { S: 'DEPT#NICHOLS#OUTBOX#MEMBER#mbr-1' },
        sk: { S: 'EVT#evt-1' },
        entityType: { S: 'OUTBOX_ENTRY' },
        eventId: { S: 'evt-1' },
        eventType: { S: 'personnel.availability.changed' },
        correlationId: { S: 'mbr-1' },
        payload: {
          M: {
            deptId: { S: 'NICHOLS' },
            memberId: { S: 'mbr-1' },
            availabilityState: { S: 'MARKED_OFF' },
          },
        },
        ...overrides,
      },
    },
  } as unknown as DynamoDBStreamEvent['Records'][number];
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../availability/dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../availability/dynamoClient.js')>();
    return { ...actual, createDdbClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

describe('outbox publisher (entrypoint-test obligation)', () => {
  it('publishes a not-yet-sent OUTBOX_ENTRY to EventBridge and marks sentAt', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    mockDdb(ddbSend);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });
    const { handler } = await import('./publisher.js');

    await handler(
      { Records: [outboxRecord()] },
      {
        eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      },
    );

    expect(ebSend).toHaveBeenCalledOnce();
    const putEventsCall = ebSend.mock.calls[0]?.[0] as {
      input: { Entries: { DetailType: string; EventBusName: string }[] };
    };
    expect(putEventsCall.input.Entries[0]?.DetailType).toBe('personnel.availability.changed');
    expect(putEventsCall.input.Entries[0]?.EventBusName).toBe('boxalarm-dev-platform-bus');
    expect(ddbSend).toHaveBeenCalledOnce();
  });

  it('skips records that are not OUTBOX_ENTRY and records already carrying sentAt', async () => {
    const ddbSend = vi.fn().mockResolvedValue({});
    mockDdb(ddbSend);
    const ebSend = vi.fn().mockResolvedValue({});
    const { handler } = await import('./publisher.js');

    const nonOutbox = outboxRecord({ entityType: { S: 'AVAILABILITY_MARKOFF' } });
    const alreadySent = outboxRecord({ sentAt: { N: '123' } });

    await handler(
      { Records: [nonOutbox, alreadySent] },
      {
        eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      },
    );

    expect(ebSend).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it('rethrows (never swallows) when PutEvents fails, so the Streams retry does its job', async () => {
    mockDdb(vi.fn());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ebSend = vi.fn().mockRejectedValue(new Error('EventBridge unavailable'));
    const { handler } = await import('./publisher.js');

    await expect(
      handler(
        { Records: [outboxRecord()] },
        {
          eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
        },
      ),
    ).rejects.toThrow('EventBridge unavailable');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('outbox.publish_failed'));
    errorSpy.mockRestore();
  });

  it('treats a ConditionalCheckFailedException on mark-sent as already-handled, not an error', async () => {
    const conditionalError = Object.assign(new Error('already sent'), {
      name: 'ConditionalCheckFailedException',
    });
    const ddbSend = vi.fn().mockRejectedValue(conditionalError);
    mockDdb(ddbSend);
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });
    const { handler } = await import('./publisher.js');

    await expect(
      handler(
        { Records: [outboxRecord()] },
        {
          eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
        },
      ),
    ).resolves.toBeUndefined();
    expect(ebSend).toHaveBeenCalledOnce();
  });
});
