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

function sqsEvent(
  payload: Record<string, unknown>,
  eventType = 'inspections.preplan.updated',
  messageId = 'msg-1',
): SQSEvent {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType,
          source: 'inspections-service',
          correlationId: 'OCC-1',
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

describe('preplan copy consumer (entrypoint-test obligation)', () => {
  it('writes summary/hazards/utilityShutoffs from an inspections.preplan.updated event (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        occupancyId: 'OCC-1',
        summary: 'Two-story residential',
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'GAS', location: 'rear' }],
      }),
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Update?: {
            Key: Record<string, string>;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        }>;
      };
    };
    const updateItem = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(updateItem?.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-1' });
    expect(updateItem?.ExpressionAttributeValues[':summary']).toBe('Two-story residential');
    expect(updateItem?.ExpressionAttributeValues[':hazards']).toEqual(['LPG_TANK_REAR']);
  });

  it('writes only nearestHydrants from an inspections.hydrant.updated event, leaving other fields untouched (AC1, partial merge)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(
      sqsEvent(
        { deptId: 'NICHOLS', occupancyId: 'OCC-1', nearestHydrants: [{ id: 'HYD-1' }] },
        'inspections.hydrant.updated',
      ),
    );

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{ Update?: { ExpressionAttributeValues: Record<string, unknown> } }>;
      };
    };
    const updateItem = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(updateItem?.ExpressionAttributeValues[':nearestHydrants']).toEqual([{ id: 'HYD-1' }]);
    expect(updateItem?.ExpressionAttributeValues[':summary']).toBeUndefined();
  });

  it('no-ops on a duplicate eventId (dedup hit) without touching the copy', async () => {
    const dedupConflict = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const { handler } = await import('./consumer.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-1', summary: 'x' }));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a stale event without throwing when the guard reports the newer-eventTime condition failed', async () => {
    const staleConflict = Object.assign(new Error('stale'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValueOnce(staleConflict);
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-1', summary: 'x' }));

    expect(send).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('rethrows on a malformed/absent payload field, never silently dropping the message', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).rejects.toThrow(
      'preplan copy event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rethrows when hazards arrives wrong-typed (object, not array)', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./consumer.js');

    await expect(
      handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-1', hazards: { bad: true } })),
    ).rejects.toThrow('preplan copy event hazards must be an array of strings when present');
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
