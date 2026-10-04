import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
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
          'detail-type': 'apparatus.serviceStatus.changed',
          source: 'apparatus-service',
          account: '123456789012',
          time: '2026-10-04T00:00:00Z',
          region: 'us-east-1',
          resources: [],
          detail: {
            eventId: 'evt-1',
            eventTime: '2026-10-04T00:00:00Z',
            eventType: 'apparatus.serviceStatus.changed',
            source: 'apparatus-service',
            correlationId: 'corr-1',
            schemaVersion: '1.0',
            payload,
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) };
  });
}

describe('apparatus-status-changed consumer (#235, entrypoint-test obligation)', () => {
  it('writes an APPARATUS_STATUS_COPY row keyed by unit, under the dept partition', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./changedHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', unitId: 'E1', status: 'OUT_OF_SERVICE' }));

    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: Array<{ Update?: { Key: Record<string, string> } }> };
    };
    const updateItem = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(updateItem?.Key).toEqual({ pk: 'DEPT#NICHOLS#APPARATUS_STATUS', sk: 'UNIT#E1' });
  });

  it('carries an optional reason, and removes it when a later event omits one', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./changedHandler.js');

    await handler(
      sqsEvent({ deptId: 'NICHOLS', unitId: 'E1', status: 'OUT_OF_SERVICE', reason: 'mechanical' }),
    );
    const withReason = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Update?: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
        }>;
      };
    };
    const reasonUpdate = withReason.input.TransactItems.find((item) => item.Update)?.Update;
    expect(reasonUpdate?.ExpressionAttributeValues[':reason']).toBe('mechanical');

    await handler(sqsEvent({ deptId: 'NICHOLS', unitId: 'E1', status: 'IN_SERVICE' }, 'msg-2'));
    const withoutReason = send.mock.calls[1]?.[0] as {
      input: { TransactItems: Array<{ Update?: { UpdateExpression: string } }> };
    };
    const noReasonUpdate = withoutReason.input.TransactItems.find((item) => item.Update)?.Update;
    expect(noReasonUpdate?.UpdateExpression).toContain('REMOVE reason');
  });

  it('no-ops on a duplicate eventId (dedup hit) without retrying', async () => {
    const dedupConflict = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const { handler } = await import('./changedHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', unitId: 'E1', status: 'IN_SERVICE' }));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows on a malformed payload, never silently dropping the message', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./changedHandler.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS', unitId: 'E1' }))).rejects.toThrow(
      'apparatus.serviceStatus.changed event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('never writes to or mentions the platform table (alerting-plane isolation)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./changedHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', unitId: 'E1', status: 'IN_SERVICE' }));

    for (const call of send.mock.calls) {
      const input = (call[0] as { input: unknown }).input;
      expect(JSON.stringify(input)).not.toContain('platform-table');
    }
  });
});
