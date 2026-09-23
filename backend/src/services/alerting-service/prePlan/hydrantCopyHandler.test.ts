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
});

function sqsEvent(payload: Record<string, unknown>) {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'inspections.hydrant.updated',
          source: 'inspections-service',
          correlationId: 'HYD-0231',
          schemaVersion: '1.0',
          payload,
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

describe('hydrantCopyHandler (entrypoint-test obligation, AC2)', () => {
  it('re-resolves and rewrites nearestHydrants for every matched PRE_PLAN_COPY item', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#NICHOLS#PREPLAN',
            sk: 'OCCUPANCY#OCC-0231',
            nearestHydrants: [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }],
          },
        ],
      })
      .mockResolvedValueOnce({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'OUT_OF_SERVICE' }));

    expect(send).toHaveBeenCalledTimes(2);
    const updateCall = send.mock.calls[1]?.[0] as {
      input: { Key: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(updateCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' });
    expect(updateCall.input.ExpressionAttributeValues[':nearestHydrants']).toEqual([]);
  });

  it('no-ops when no PRE_PLAN_COPY item references this hydrantId', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          pk: 'DEPT#NICHOLS#PREPLAN',
          sk: 'OCCUPANCY#OCC-9999',
          nearestHydrants: [{ hydrantId: 'HYD-OTHER', status: 'IN_SERVICE' }],
        },
      ],
    });
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'OUT_OF_SERVICE' }));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('guards the write on its own hydrantsUpdatedAt watermark, never snapshotUpdatedAt (P4)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#NICHOLS#PREPLAN',
            sk: 'OCCUPANCY#OCC-0231',
            nearestHydrants: [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }],
          },
        ],
      })
      .mockResolvedValueOnce({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'OUT_OF_SERVICE' }));

    const updateCall = send.mock.calls[1]?.[0] as {
      input: { ConditionExpression: string };
    };
    expect(updateCall.input.ConditionExpression).toContain('hydrantsUpdatedAt');
    expect(updateCall.input.ConditionExpression).not.toContain('snapshotUpdatedAt');
  });

  it('retries a concurrent-write race (stale array read) with a fresh read, then succeeds (P2)', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#NICHOLS#PREPLAN',
            sk: 'OCCUPANCY#OCC-0231',
            nearestHydrants: [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }],
            hydrantsUpdatedAt: 1,
          },
        ],
      })
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: 'stale list', $metadata: {} }),
      )
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS#PREPLAN',
          sk: 'OCCUPANCY#OCC-0231',
          nearestHydrants: [
            { hydrantId: 'HYD-0231', status: 'IN_SERVICE' },
            { hydrantId: 'HYD-9999', status: 'IN_SERVICE' },
          ],
          hydrantsUpdatedAt: 500,
        },
      })
      .mockResolvedValueOnce({});
    mockDdb(send);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'OUT_OF_SERVICE' }));

    expect(send).toHaveBeenCalledTimes(4);
    const retriedUpdate = send.mock.calls[3]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(retriedUpdate.input.ExpressionAttributeValues[':nearestHydrants']).toEqual([
      { hydrantId: 'HYD-9999', status: 'IN_SERVICE' },
    ]);
  });

  it('discards as stale when a fresh read shows a newer hydrantsUpdatedAt already won the race (P2)', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: 'DEPT#NICHOLS#PREPLAN',
            sk: 'OCCUPANCY#OCC-0231',
            nearestHydrants: [{ hydrantId: 'HYD-0231', status: 'IN_SERVICE' }],
            hydrantsUpdatedAt: 1,
          },
        ],
      })
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: 'stale', $metadata: {} }),
      )
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS#PREPLAN',
          sk: 'OCCUPANCY#OCC-0231',
          nearestHydrants: [],
          hydrantsUpdatedAt: 9_999_999_999_999,
        },
      });
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'OUT_OF_SERVICE' }));

    expect(send).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  it('re-throws when the dept-partition Query fails — fail-closed, no writes attempted', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(
      handler(sqsEvent({ deptId: 'NICHOLS', hydrantId: 'HYD-0231', status: 'IN_SERVICE' })),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('re-throws on a malformed envelope before any query is attempted', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./hydrantCopyHandler.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).rejects.toThrow(/hydrantId/);
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
