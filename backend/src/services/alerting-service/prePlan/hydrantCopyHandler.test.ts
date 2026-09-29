import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function envelope(payload: Record<string, unknown>) {
  return {
    eventId: 'evt-1',
    eventTime: '2026-09-06T00:00:00Z',
    eventType: 'inspections.hydrant.updated',
    source: 'inspections-service',
    correlationId: 'HYD-0231',
    schemaVersion: '1.0',
    payload,
  };
}

/** What the EventBridge rule -> SQS target (no input transformer) actually delivers. */
function sqsEvent(payload: Record<string, unknown>) {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          version: '0',
          id: 'eb-1',
          'detail-type': 'inspections.hydrant.updated',
          source: 'inspections-service',
          detail: envelope(payload),
        }),
      },
    ],
  } as unknown as SQSEvent;
}

const FULL_PAYLOAD = {
  hydrantId: 'HYD-0231',
  deptId: 'NICHOLS',
  latitude: 41.2417,
  longitude: -73.2004,
  status: 'IN_SERVICE',
  size: '6-inch',
  flowRatingGpm: 1000,
};

interface TransactInput {
  input: {
    TransactItems: Array<{
      Put?: { Item: Record<string, unknown>; ConditionExpression: string };
      Update?: {
        Key: Record<string, string>;
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    }>;
  };
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

function sentTransaction(send: ReturnType<typeof vi.fn>) {
  const items = (send.mock.calls[0]?.[0] as TransactInput).input.TransactItems;
  return { dedup: items[0]?.Put, update: items[1]?.Update };
}

describe('hydrantCopyHandler (entrypoint)', () => {
  it('upserts one geo-indexed HYDRANT_COPY per hydrant with status, size and flow rating', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent(FULL_PAYLOAD));

    expect(send).toHaveBeenCalledOnce();
    const { update } = sentTransaction(send);
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#HYDRANT', sk: 'HYDRANT#HYD-0231' });
    const values = update?.ExpressionAttributeValues ?? {};
    expect(values).toMatchObject({
      ':entityType': 'HYDRANT_COPY',
      ':hydrantId': 'HYD-0231',
      ':status': 'IN_SERVICE',
      ':size': '6-inch',
      ':flowRatingGpm': 1000,
      ':latitude': 41.2417,
      ':longitude': -73.2004,
      ':hydrantUpdatedAt': Date.parse('2026-09-06T00:00:00Z'),
    });
    expect(values[':gsi2pk']).toMatch(/^DEPT#NICHOLS#HYDRANT_GEO#[0-9b-hj-km-np-z]{5}$/);
    expect(values[':gsi2sk']).toMatch(/^[0-9b-hj-km-np-z]{9}#HYD-0231$/);
    expect((values[':gsi2sk'] as string).slice(0, 5)).toBe((values[':gsi2pk'] as string).slice(-5));
    // status and size are DynamoDB reserved words.
    expect(update?.ExpressionAttributeNames).toMatchObject({
      '#status': 'status',
      '#size': 'size',
    });
  });

  it('keeps the dedup and staleness guards: one EVT# marker per event, and an eventTime watermark', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent(FULL_PAYLOAD));

    const { dedup, update } = sentTransaction(send);
    expect(dedup?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#DEDUP#hydrant-copy-consumer#HYD-0231',
      sk: 'EVT#evt-1',
      entityType: 'EVENT_DEDUP',
    });
    expect(dedup?.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(update?.ConditionExpression).toBe(
      '(attribute_not_exists(hydrantUpdatedAt) OR :hydrantUpdatedAt > hydrantUpdatedAt) AND attribute_not_exists(archivedAt)',
    );
  });

  it('a status-only event sets status without blanking a known size or flow rating', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ hydrantId: 'HYD-0231', deptId: 'NICHOLS', status: 'OUT_OF_SERVICE' }));

    const { update } = sentTransaction(send);
    expect(update?.UpdateExpression).toContain('#status = :status');
    expect(update?.UpdateExpression).not.toContain('size');
    expect(update?.UpdateExpression).not.toContain('flowRatingGpm');
    expect(update?.UpdateExpression).not.toContain('gsi2pk');
  });

  it('flags a hydrant stored without a location — it can never be listed as nearest', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ hydrantId: 'HYD-0231', deptId: 'NICHOLS', status: 'IN_SERVICE' }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('hydrant_copy.written_without_location'),
    );
  });

  it('tombstones an archived hydrant: removes its geo keys and blocks later events', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ hydrantId: 'HYD-0231', deptId: 'NICHOLS', archived: true }));

    const { update } = sentTransaction(send);
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#HYDRANT', sk: 'HYDRANT#HYD-0231' });
    expect(update?.UpdateExpression).toContain('archivedAt = :hydrantUpdatedAt');
    expect(update?.UpdateExpression).toContain('REMOVE gsi2pk, gsi2sk');
    expect(update?.ConditionExpression).toContain('attribute_not_exists(archivedAt)');
    expect(update).not.toHaveProperty('ExpressionAttributeNames');
  });

  it.each([
    ['duplicate eventId redelivery', [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }]],
    ['stale (older) eventTime', [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]],
  ])('skips a %s without throwing', async (_label, reasons) => {
    const conflict = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: reasons,
    });
    const send = vi.fn().mockRejectedValueOnce(conflict);
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(handler(sqsEvent(FULL_PAYLOAD))).resolves.toEqual({ batchItemFailures: [] });
    expect(send).toHaveBeenCalledOnce();
  });

  it('reports a non-conditional DynamoDB failure as a batch item failure so SQS redelivers just it', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(handler(sqsEvent(FULL_PAYLOAD))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
  });

  it('rejects an envelope at the top level of the SQS body before any write', async () => {
    const send = vi.fn();
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(
      handler({
        Records: [{ messageId: 'msg-1', body: JSON.stringify(envelope(FULL_PAYLOAD)) }],
      } as unknown as SQSEvent),
    ).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a payload with no hydrantId before any write', async () => {
    const send = vi.fn();
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('a poison message fails alone: the valid records in its batch are still written (minor 3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');
    const good = sqsEvent(FULL_PAYLOAD).Records[0]!;

    const result = await handler({
      Records: [
        { ...good, messageId: 'good-1' },
        { messageId: 'poison', body: '{not json' },
        { ...good, messageId: 'good-2' },
        { ...good, messageId: 'bad-id', body: good.body.replaceAll('HYD-0231', 'HYD#0231') },
      ],
    } as unknown as SQSEvent);

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'poison' }, { itemIdentifier: 'bad-id' }],
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
