import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** A real EventBridge->SQS body: the rule target has no inputPath. */
function sqsEvent(payload: Record<string, unknown>, messageId = 'msg-1'): SQSEvent {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify({
          version: '0',
          id: 'eb-evt-1',
          'detail-type': 'personnel.attendance.recorded',
          source: 'personnel-service',
          account: '123456789012',
          time: '2026-10-04T00:00:00Z',
          region: 'us-east-1',
          resources: [],
          detail: {
            eventId: 'evt-1',
            eventTime: '2026-10-04T00:00:00Z',
            eventType: 'personnel.attendance.recorded',
            source: 'personnel-service',
            correlationId: 'mbr-1',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) };
  });
}

describe('losap accrual consumer (#206, entrypoint-test obligation)', () => {
  it('writes an EVENT_DEDUP marker keyed by member and eventId, never re-awarding points', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./accrualConsumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        activityType: 'DRILL',
        activityId: 'drill-1',
        losapPoints: 2,
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const put = send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } };
    expect(put.input.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#DEDUP#losap-accrual-consumer#mbr-1',
      sk: 'EVT#evt-1',
      entityType: 'EVENT_DEDUP',
      losapPoints: 2,
    });
  });

  it('no-ops on a duplicate eventId (dedup hit) without retrying', async () => {
    const dedupConflict = new ConditionalCheckFailedException({
      message: 'condition failed',
      $metadata: {},
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const { handler } = await import('./accrualConsumer.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        activityType: 'DRILL',
        activityId: 'drill-1',
        losapPoints: 2,
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows on a malformed payload, never silently dropping the message', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./accrualConsumer.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS', memberId: 'mbr-1' }))).rejects.toThrow(
      'personnel.attendance.recorded event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
