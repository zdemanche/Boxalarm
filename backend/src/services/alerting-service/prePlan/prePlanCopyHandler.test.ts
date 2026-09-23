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

function sqsEvent(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          eventId: 'evt-1',
          eventTime: '2026-09-06T00:00:00Z',
          eventType: 'inspections.preplan.updated',
          source: 'inspections-service',
          correlationId: 'PP-0044',
          schemaVersion: '1.0',
          payload,
          ...overrides,
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

describe('prePlanCopyHandler (entrypoint-test obligation, AC1)', () => {
  it('writes a PRE_PLAN_COPY item at pk=DEPT#{deptId}#PREPLAN / sk=OCCUPANCY#{occupancyId} with summary/hazards/utilityShutoffs', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        occupancyId: 'OCC-0231',
        summary: 'Two-story residential',
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'gas', location: 'rear' }],
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
    const update = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(update?.Key).toEqual({ pk: 'DEPT#NICHOLS#PREPLAN', sk: 'OCCUPANCY#OCC-0231' });
    expect(update?.ExpressionAttributeValues[':summary']).toBe('Two-story residential');
    expect(update?.ExpressionAttributeValues[':hazards']).toEqual(['LPG_TANK_REAR']);
    expect(update?.ExpressionAttributeValues[':utilityShutoffs']).toEqual([
      { utility: 'gas', location: 'rear' },
    ]);
  });

  it('guards the write on its own prePlanUpdatedAt watermark, never the hydrant stream watermark (P4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }));

    const transactCall = send.mock.calls[0]?.[0] as {
      input: { TransactItems: Array<{ Update?: { ConditionExpression: string } }> };
    };
    const update = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(update?.ConditionExpression).toContain('attribute_not_exists(prePlanUpdatedAt)');
    expect(update?.ConditionExpression).toContain('> prePlanUpdatedAt');
    expect(update?.ConditionExpression).not.toContain('attribute_not_exists(snapshotUpdatedAt)');
    expect(update?.ConditionExpression).not.toContain('> snapshotUpdatedAt');
  });

  it('flags a write missing AC1 attributes rather than no-opping silently (P5)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('preplan_copy.written_with_missing_fields'),
    );
    errorSpy.mockRestore();
  });

  it('does not flag missing fields when the payload carries summary/hazards/utilityShutoffs (P5)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(
      sqsEvent({
        deptId: 'NICHOLS',
        occupancyId: 'OCC-0231',
        summary: 'Two-story residential',
        hazards: ['LPG_TANK_REAR'],
        utilityShutoffs: [{ utility: 'gas', location: 'rear' }],
      }),
    );

    const calls = errorSpy.mock.calls.map((call) => call[0] as string);
    expect(calls.some((body) => body.includes('preplan_copy.written_with_missing_fields'))).toBe(
      false,
    );
    errorSpy.mockRestore();
  });

  it('sets snapshotUpdatedAt to Date.parse(eventTime), the source-event timestamp, not write-time Date.now() (AC4)', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockDdb(send);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }));

    const transactCall = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{ Update?: { ExpressionAttributeValues: Record<string, unknown> } }>;
      };
    };
    const update = transactCall.input.TransactItems.find((item) => item.Update)?.Update;
    expect(update?.ExpressionAttributeValues[':snapshotUpdatedAt']).toBe(
      Date.parse('2026-09-06T00:00:00Z'),
    );
  });

  it('no-ops on a duplicate eventId redelivery without throwing', async () => {
    const dedupConflict = Object.assign(new Error('dup'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValueOnce(dedupConflict);
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }));

    expect(send).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('discards a stale eventTime (older than stored snapshotUpdatedAt) without throwing', async () => {
    const staleConflict = Object.assign(new Error('stale'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValueOnce(staleConflict);
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }));

    expect(send).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('re-throws on a non-conditional DynamoDB failure — fail-closed, no partial write swallowed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS', occupancyId: 'OCC-0231' }))).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('re-throws on a malformed envelope before any write is attempted', async () => {
    const send = vi.fn();
    mockDdb(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./prePlanCopyHandler.js');

    await expect(handler(sqsEvent({ deptId: 'NICHOLS' }))).rejects.toThrow(
      'inspections.preplan.updated event failed shape validation',
    );
    expect(send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
