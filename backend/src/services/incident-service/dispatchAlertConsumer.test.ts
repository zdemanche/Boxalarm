import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createHandler } from './dispatchAlertConsumer.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, index) => ({ messageId: `msg-${index}`, body }) as SQSEvent['Records'][number],
    ),
  };
}

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    detail: {
      payload: {
        deptId: 'NICHOLS',
        dispatchId: 'NICHOLS-MANUAL-1798000000-abcd1234',
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
        crossStreets: 'Elm & 1st',
        narrative: 'Smoke showing from second floor',
        dispatchedAt: 1_798_000_000,
        ...overrides,
      },
    },
  });
}

describe('dispatchAlertConsumer', () => {
  it('writes a DISPATCH_ALERT_COPY projection from a dispatch.alert.received record (E6-S2 AC1/AC2)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    await handler(sqsEvent([validBody()]), {} as never, () => undefined);

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [{ input: { Item: Record<string, unknown> } }];
    expect(command.input.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#DISPATCH_COPY#NICHOLS-MANUAL-1798000000-abcd1234',
      sk: 'METADATA',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      narrative: 'Smoke showing from second floor',
    });
  });

  it('carries a CAD verifyRequired flag onto the copy only when the payload has it', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    await handler(
      sqsEvent([
        validBody({ address: 'SEE DISPATCH TEXT', verifyRequired: true }),
        validBody({ dispatchId: 'D-2' }),
      ]),
      {} as never,
      () => undefined,
    );

    const items = send.mock.calls.map(
      (call) => (call[0] as { input: { Item: Record<string, unknown> } }).input.Item,
    );
    expect(items[0]).toMatchObject({ verifyRequired: true });
    expect(items[1]).not.toHaveProperty('verifyRequired');
  });

  it('reports a malformed record as a batch item failure without writing it', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    const result = await handler(
      sqsEvent([JSON.stringify({ detail: { payload: {} } })]),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-0' }] });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps processing after a failed write, reporting only the failed record', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('DynamoDB unavailable'))
      .mockResolvedValueOnce({});
    const handler = createHandler({ client: { send } as never });

    const result = await handler(
      sqsEvent([validBody(), validBody({ dispatchId: 'NICHOLS-MANUAL-1798000001-ef567890' })]),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-0' }] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stores the payload revision (0 when absent) and guards the Put against an older one', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = createHandler({ client: { send } as never });

    await handler(
      sqsEvent([validBody({ revision: 3 }), validBody({ dispatchId: 'D-2' })]),
      {} as never,
      () => undefined,
    );

    const inputs = send.mock.calls.map(
      (call) =>
        (call[0] as { input: Record<string, unknown> & { Item: Record<string, unknown> } }).input,
    );
    expect(inputs[0]?.Item).toMatchObject({ revision: 3 });
    expect(inputs[1]?.Item).toMatchObject({ revision: 0 });
    expect(inputs[0]?.ConditionExpression).toContain('revision <= :revision');
    expect(inputs[0]?.ExpressionAttributeValues).toEqual({ ':revision': 3 });
  });

  it('acknowledges a redelivered older revision without failing the batch', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'stale', $metadata: {} }));
    const handler = createHandler({ client: { send } as never });

    const result = await handler(
      sqsEvent([validBody({ revision: 0 })]),
      {} as never,
      () => undefined,
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
