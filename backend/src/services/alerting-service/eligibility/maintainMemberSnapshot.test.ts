import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

function memberUpdatedRecord(overrides: {
  eventId?: string;
  phone?: string;
  deptId?: string;
  memberId?: string;
}): SQSRecord {
  const {
    eventId = 'evt-1',
    phone = '555-0100',
    deptId = 'NICHOLS',
    memberId = 'mbr-1',
  } = overrides;
  return {
    messageId: 'msg-1',
    body: JSON.stringify({
      detail: {
        eventId,
        eventTime: '2026-09-14T00:00:00.000Z',
        eventType: 'personnel.member.updated',
        source: 'personnel-service',
        correlationId: memberId,
        schemaVersion: '1.0',
        payload: { deptId, memberId, phone },
      },
    }),
  } as unknown as SQSRecord;
}

function buildSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

describe('maintainMemberSnapshot handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('upserts contactChannels with the new phone so future dispatches use it (AC3, core-harm)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: undefined }) // dedup get - not yet processed
      .mockResolvedValueOnce({ Item: undefined }) // existing snapshot get (none yet)
      .mockResolvedValueOnce({}) // update snapshot
      .mockResolvedValueOnce({}); // put dedup completion marker
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined);

    expect(send).toHaveBeenCalledTimes(4);
    const updateCall = send.mock.calls[2]?.[0] as {
      input: {
        Key: { pk: string; sk: string };
        ExpressionAttributeValues: {
          ':contactChannels': Array<{ channel: string; token: string }>;
        };
      };
    };
    expect(updateCall.input.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-1' });
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toContainEqual({
      channel: 'sms',
      token: '555-0100',
    });
  });

  it('preserves non-SMS channels already on the snapshot', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({
        Item: { contactChannels: [{ channel: 'push', token: 'push-token-1' }] },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined);

    const updateCall = send.mock.calls[2]?.[0] as {
      input: {
        ExpressionAttributeValues: {
          ':contactChannels': Array<{ channel: string; token: string }>;
        };
      };
    };
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toContainEqual({
      channel: 'push',
      token: 'push-token-1',
    });
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toContainEqual({
      channel: 'sms',
      token: '555-0100',
    });
  });

  it('never unconditionally overwrites active/availabilityState/roles/quals on the snapshot write (regression: P7)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined);

    const updateCall = send.mock.calls[2]?.[0] as { input: { UpdateExpression: string } };
    expect(updateCall.input.UpdateExpression).toContain('if_not_exists(active, :defaultActive)');
    expect(updateCall.input.UpdateExpression).toContain(
      'if_not_exists(availabilityState, :defaultAvailability)',
    );
    expect(updateCall.input.UpdateExpression).toContain('if_not_exists(roles, :emptyList)');
    expect(updateCall.input.UpdateExpression).toContain('if_not_exists(quals, :emptyList)');
  });

  it('skips a duplicate eventId without touching the snapshot (dedup)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi.fn().mockResolvedValueOnce({ Item: { pk: 'x', sk: 'y' } });
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a stale (out-of-order) event without writing the dedup marker', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: undefined })
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: 'stale', $metadata: {} }),
      );
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined);

    expect(send).toHaveBeenCalledTimes(3);
  });

  it('logs the original error and rethrows on an alerting-table write failure (fail-closed to DLQ retry)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValueOnce(new Error('table throttled'));
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined),
    ).rejects.toThrow('table throttled');

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      reason: string;
      message: string;
    };
    expect(logged.reason).toBe('Error');
    expect(logged.message).toBe('table throttled');

    errorSpy.mockRestore();
  });

  it('recovers from a transient snapshot-write failure without losing the update on redelivery (regression: P4)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: undefined }) // attempt 1: dedup get - not found
      .mockResolvedValueOnce({ Item: undefined }) // attempt 1: existing snapshot get
      .mockRejectedValueOnce(new Error('transient write failure')); // attempt 1: update snapshot fails
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });
    const record = memberUpdatedRecord({ eventId: 'evt-redelivered' });

    await expect(handler(buildSqsEvent([record]), {} as never, () => undefined)).rejects.toThrow(
      'transient write failure',
    );
    expect(send).toHaveBeenCalledTimes(3);

    send
      .mockResolvedValueOnce({ Item: undefined }) // attempt 2 (redelivery): dedup get - still unmarked
      .mockResolvedValueOnce({ Item: undefined }) // attempt 2: existing snapshot get
      .mockResolvedValueOnce({}) // attempt 2: update snapshot succeeds
      .mockResolvedValueOnce({}); // attempt 2: put dedup marker

    await handler(buildSqsEvent([record]), {} as never, () => undefined);

    expect(send).toHaveBeenCalledTimes(7);
    const updateCall = send.mock.calls[5]?.[0] as {
      input: {
        ExpressionAttributeValues: {
          ':contactChannels': Array<{ channel: string; token: string }>;
        };
      };
    };
    expect(updateCall.input.ExpressionAttributeValues[':contactChannels']).toContainEqual({
      channel: 'sms',
      token: '555-0100',
    });

    errorSpy.mockRestore();
  });

  it('rethrows on an empty/malformed SQS record body (lands in DLQ, never silently dropped)', async () => {
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn();
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });
    const malformed = { messageId: 'msg-bad', body: 'not-json' } as unknown as SQSRecord;

    await expect(
      handler(buildSqsEvent([malformed]), {} as never, () => undefined),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('throws when ALERTING_TABLE_NAME is unset, before any AWS call (misconfigured deployment)', async () => {
    delete process.env.ALERTING_TABLE_NAME;
    const { createHandler } = await import('./maintainMemberSnapshot.js');
    const send = vi.fn();
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(buildSqsEvent([memberUpdatedRecord({})]), {} as never, () => undefined),
    ).rejects.toThrow('ALERTING_TABLE_NAME is required and was not set');
    expect(send).not.toHaveBeenCalled();
  });

  it('exercises the exported handler (entrypoint test) with an empty batch', async () => {
    const { handler } = await import('./maintainMemberSnapshot.js');
    await expect(handler(buildSqsEvent([]), {} as never, () => undefined)).resolves.toBeUndefined();
  });
});
