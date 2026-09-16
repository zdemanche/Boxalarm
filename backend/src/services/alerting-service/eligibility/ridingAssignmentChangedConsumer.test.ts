import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

const loggedErrors = vi.fn();
vi.mock('../logger.js', () => ({ logError: loggedErrors, logInfo: vi.fn() }));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  loggedErrors.mockClear();
  process.env.ALERTING_TABLE_NAME = 'alerting-table';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function detailBody(
  envelopeOverrides: Partial<Record<string, unknown>> = {},
  payloadOverrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    detail: {
      eventId: 'evt-1',
      eventTime: '2026-09-14T12:00:00.000Z',
      eventType: 'apparatus.riding_assignment.assigned',
      payload: {
        deptId: 'NICHOLS',
        dispatchId: 'DISPATCH-1',
        apparatusId: 'APP-ENGINE-2',
        memberId: 'MBR-0012',
        previousMemberId: null,
        ...payloadOverrides,
      },
      ...envelopeOverrides,
    },
  });
}

function stubSend(
  route: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((command: unknown) =>
    Promise.resolve(route(command as { constructor: { name: string }; input: Record<string, unknown> })),
  );
}

describe('ridingAssignmentChangedConsumer handler (entrypoint)', () => {
  it('AC2: sets assignedApparatusId on the assigned member roster row', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') return {};
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const input = (updateCall?.[0] as { input: { Key: { sk: string }; ExpressionAttributeValues: Record<string, unknown> } })
      .input;
    expect(input.Key.sk).toBe('ROSTER#MBR-0012');
    expect(input.ExpressionAttributeValues[':apparatusId']).toBe('APP-ENGINE-2');
  });

  it('AC2/AC6: clears the previous occupant assignedApparatusId when a seat is reassigned', async () => {
    const send = stubSend(() => ({}));
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { previousMemberId: 'MBR-0034' }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCalls = send.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCalls).toHaveLength(2);
    const clearedCall = updateCalls.find(
      (call) => (call[0] as { input: { Key: { sk: string } } }).input.Key.sk === 'ROSTER#MBR-0034',
    );
    expect(
      (clearedCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }).input
        .ExpressionAttributeValues[':apparatusId'],
    ).toBeNull();
  });

  it('does not clear the previous occupant when they have since been reassigned to a different apparatus (regression: unconditional clear bug)', async () => {
    // Member MBR-0034 was displaced from APP-ENGINE-2 by this event, but the roster already
    // shows them riding a *different* apparatus (they were given a second seat elsewhere,
    // which this system allows -- seats are not auto-vacated). Clearing here would wrongly
    // un-seat someone who is actually still riding.
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = stubSend((command) => {
      if (command.constructor.name === 'UpdateCommand') {
        const key = command.input.Key as { sk: string };
        if (key.sk === 'ROSTER#MBR-0034') {
          throw new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} });
        }
      }
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { previousMemberId: 'MBR-0034' }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    // The consumer must have attempted the clear (and the guard condition rejected it, not an
    // unconditional write that would have silently succeeded and wrongly un-seated MBR-0034).
    const clearAttempt = send.mock.calls.find(
      (call) =>
        (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand' &&
        (call[0] as { input: { Key: { sk: string } } }).input.Key.sk === 'ROSTER#MBR-0034',
    );
    expect(clearAttempt).toBeDefined();
    const values = (
      clearAttempt?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':requireCurrentApparatusId']).toBe('APP-ENGINE-2');
  });

  it('does not create an orphan roster row when none exists yet (regression: upsert bug)', async () => {
    const send = stubSend(() => ({}));
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    const conditionExpression = (updateCall?.[0] as { input: { ConditionExpression: string } }).input
      .ConditionExpression;
    expect(conditionExpression).toContain('attribute_exists(pk)');
  });

  it('skips without updating the roster on a duplicate eventId (dedup)', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand' && (command.input.Key as { sk: string }).sk === 'EVT#evt-1') {
        return { Item: { pk: 'x', sk: 'EVT#evt-1' } };
      }
      return {};
    });
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeUndefined();
  });

  it('throws on a malformed payload so SQS retries the batch', async () => {
    const send = vi.fn();
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        {
          Records: [{ messageId: 'm1', body: detailBody({}, { apparatusId: undefined }) }],
        } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow();

    expect(loggedErrors).toHaveBeenCalled();
  });

  it('throws when the DynamoDB update fails unexpectedly (fail-closed, SQS retry/DLQ)', async () => {
    const send = stubSend((command) => {
      if (command.constructor.name === 'GetCommand') return {};
      throw new Error('DynamoDB unavailable');
    });
    const { createHandler } = await import('./ridingAssignmentChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(loggedErrors).toHaveBeenCalled();
  });
});
