import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';

function buildStreamEvent(
  entry: Record<string, unknown>,
  eventName: 'INSERT' | 'MODIFY' = 'INSERT',
) {
  return {
    Records: [
      {
        eventName,
        dynamodb: {
          NewImage: marshall(entry),
          Keys: marshall({ pk: entry.pk, sk: entry.sk }),
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

describe('publishOutbox handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_BUS_NAME = 'platform-bus';
    process.env.PERSONNEL_TABLE_NAME = 'personnel-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('./eventBridgeClient.js');
    vi.doUnmock('../dynamoClient.js');
  });

  it('publishes an unsent OUTBOX_ENTRY to EventBridge and marks sentAt (AC1)', async () => {
    const eventBridgeSend = vi.fn().mockResolvedValue({});
    const dynamoSend = vi.fn().mockResolvedValue({});
    vi.doMock('./eventBridgeClient.js', () => ({
      createEventBridgeClient: () => ({ send: eventBridgeSend }),
      readEventBusConfig: () => ({ busName: 'platform-bus' }),
    }));
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }),
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./publishOutbox.js');
    const result = await handler(
      buildStreamEvent({
        pk: 'DEPT#NICHOLS#OUTBOX#mbr-102',
        sk: 'EVT#evt-1',
        entityType: 'OUTBOX_ENTRY',
        eventId: 'evt-1',
        eventTime: '2026-09-14T00:00:00.000Z',
        eventType: 'personnel.member.updated',
        source: 'personnel-service',
        correlationId: 'mbr-102',
        schemaVersion: '1.0',
        payload: { memberId: 'mbr-102' },
        sentAt: null,
      }),
    );

    expect(eventBridgeSend).toHaveBeenCalledTimes(1);
    const putEvents = eventBridgeSend.mock.calls[0]?.[0] as { input: { Entries: unknown[] } };
    expect(putEvents.input.Entries).toHaveLength(1);
    expect(dynamoSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('skips a record that already carries sentAt', async () => {
    const eventBridgeSend = vi.fn();
    const dynamoSend = vi.fn();
    vi.doMock('./eventBridgeClient.js', () => ({
      createEventBridgeClient: () => ({ send: eventBridgeSend }),
      readEventBusConfig: () => ({ busName: 'platform-bus' }),
    }));
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }),
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./publishOutbox.js');
    await handler(
      buildStreamEvent({
        pk: 'DEPT#NICHOLS#OUTBOX#mbr-102',
        sk: 'EVT#evt-1',
        entityType: 'OUTBOX_ENTRY',
        eventId: 'evt-1',
        eventTime: '2026-09-14T00:00:00.000Z',
        eventType: 'personnel.member.updated',
        source: 'personnel-service',
        correlationId: 'mbr-102',
        schemaVersion: '1.0',
        payload: {},
        sentAt: '2026-09-14T00:00:01.000Z',
      }),
    );

    expect(eventBridgeSend).not.toHaveBeenCalled();
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('throws and does not mark sentAt when PutEvents reports FailedEntryCount > 0 (P11 regression)', async () => {
    const eventBridgeSend = vi
      .fn()
      .mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException' }] });
    const dynamoSend = vi.fn();
    vi.doMock('./eventBridgeClient.js', () => ({
      createEventBridgeClient: () => ({ send: eventBridgeSend }),
      readEventBusConfig: () => ({ busName: 'platform-bus' }),
    }));
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }),
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./publishOutbox.js');
    await expect(
      handler(
        buildStreamEvent({
          pk: 'DEPT#NICHOLS#OUTBOX#mbr-102',
          sk: 'EVT#evt-1',
          entityType: 'OUTBOX_ENTRY',
          eventId: 'evt-1',
          eventTime: '2026-09-14T00:00:00.000Z',
          eventType: 'personnel.member.updated',
          source: 'personnel-service',
          correlationId: 'mbr-102',
          schemaVersion: '1.0',
          payload: {},
          sentAt: null,
        }),
      ),
    ).rejects.toThrow('ThrottlingException');
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('throws (does not swallow) when PutEvents fails, so the Streams batch retries', async () => {
    const eventBridgeSend = vi.fn().mockRejectedValue(new Error('EventBridge outage'));
    const dynamoSend = vi.fn();
    vi.doMock('./eventBridgeClient.js', () => ({
      createEventBridgeClient: () => ({ send: eventBridgeSend }),
      readEventBusConfig: () => ({ busName: 'platform-bus' }),
    }));
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => ({ send: dynamoSend }),
      readPersonnelConfig: () => ({ tableName: 'personnel-table' }),
    }));

    const { handler } = await import('./publishOutbox.js');
    await expect(
      handler(
        buildStreamEvent({
          pk: 'DEPT#NICHOLS#OUTBOX#mbr-102',
          sk: 'EVT#evt-1',
          entityType: 'OUTBOX_ENTRY',
          eventId: 'evt-1',
          eventTime: '2026-09-14T00:00:00.000Z',
          eventType: 'personnel.member.updated',
          source: 'personnel-service',
          correlationId: 'mbr-102',
          schemaVersion: '1.0',
          payload: {},
          sentAt: null,
        }),
      ),
    ).rejects.toThrow('EventBridge outage');
  });
});
