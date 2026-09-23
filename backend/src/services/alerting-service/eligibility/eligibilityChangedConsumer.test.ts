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
      eventType: 'personnel.eligibility.changed',
      payload: {
        deptId: 'NICHOLS',
        memberId: 'mbr-1',
        qualCode: 'INTERIOR',
        currentlyEligible: false,
        grantedByCertId: 'CERT-0091',
        ...payloadOverrides,
      },
      ...envelopeOverrides,
    },
  });
}

function createStatefulSend(
  initialSnapshot?: Record<string, unknown>,
  forceUpdateFailures = 0,
): { send: ReturnType<typeof vi.fn>; store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  if (initialSnapshot) {
    store.set('MEMBER#mbr-1', initialSnapshot);
  }
  const dedup = new Set<string>();
  let updateAttempts = 0;
  const send = vi.fn().mockImplementation(async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    const input = (command as unknown as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input.Key as { sk: string }).sk;
      if (key.startsWith('EVT#')) {
        return dedup.has(key) ? { Item: { pk: 'x', sk: key } } : {};
      }
      const item = store.get(key);
      return item ? { Item: item } : {};
    }
    if (name === 'UpdateCommand') {
      updateAttempts += 1;
      const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
      if (updateAttempts <= forceUpdateFailures) {
        throw new ConditionalCheckFailedException({ message: 'concurrent write', $metadata: {} });
      }
      const key = (input.Key as { sk: string }).sk;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const current = store.get(key);
      if (
        current &&
        JSON.stringify(current.quals ?? []) !== JSON.stringify(values[':priorQuals'])
      ) {
        throw new ConditionalCheckFailedException({ message: 'stale read', $metadata: {} });
      }
      store.set(key, {
        quals: values[':quals'],
        snapshotUpdatedAt: values[':new'],
        memberId: values[':memberId'],
        entityType: values[':entityType'],
      });
      return {};
    }
    if (name === 'PutCommand') {
      const key = (input.Item as { sk: string }).sk;
      dedup.add(key);
      return {};
    }
    return {};
  });
  return { send, store };
}

describe('eligibilityChangedConsumer handler (entrypoint)', () => {
  it('removes the qualCode from quals[] when currentlyEligible is false (AC3)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        const input = (command as unknown as { input: { Key: { sk: string } } }).input;
        if (input.Key.sk === 'MEMBER#mbr-1') {
          return Promise.resolve({
            Item: { quals: ['INTERIOR', 'DRIVER'], snapshotUpdatedAt: 1000 },
          });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    const values = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':quals']).toEqual(['DRIVER']);
  });

  it('adds the qualCode to quals[] when currentlyEligible is true', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        const input = (command as unknown as { input: { Key: { sk: string } } }).input;
        if (input.Key.sk === 'MEMBER#mbr-1') {
          return Promise.resolve({ Item: { quals: [], snapshotUpdatedAt: 1000 } });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { currentlyEligible: true }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    const values = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':quals']).toEqual(['INTERIOR']);
  });

  it('skips without updating the snapshot on a duplicate eventId (dedup)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        const input = (command as unknown as { input: { Key: { sk: string } } }).input;
        if (input.Key.sk === 'EVT#evt-1') {
          return Promise.resolve({ Item: { pk: 'x', sk: 'EVT#evt-1' } });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
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

  it('skips a stale event without ever writing when a newer qualsUpdatedAt is already stored', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        const input = (command as unknown as { input: { Key: { sk: string } } }).input;
        if (input.Key.sk === 'MEMBER#mbr-1') {
          return Promise.resolve({
            Item: {
              quals: ['INTERIOR'],
              qualsUpdatedAt: Date.parse('2026-09-14T12:00:00.000Z') + 1000,
            },
          });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).resolves.toBeUndefined();

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeUndefined();
  });

  it('applies a qual update even when snapshotUpdatedAt is newer from an unrelated availability event (cross-domain staleness, core-harm)', async () => {
    // consumer.ts (personnel.availability.changed) writes the same MEMBER_ELIGIBILITY_SNAPSHOT
    // item and bumps snapshotUpdatedAt independently. If this consumer gated its own staleness
    // check on that shared field, a later-but-unrelated availability update would make this
    // qual update look stale and silently drop it -- staleness must be judged against our own
    // qualsUpdatedAt, never the shared snapshotUpdatedAt.
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        const input = (command as unknown as { input: { Key: { sk: string } } }).input;
        if (input.Key.sk === 'MEMBER#mbr-1') {
          return Promise.resolve({
            Item: {
              quals: ['INTERIOR'],
              // An availability event bumped this well after our own eventTime (2026-09-14T12:00:00.000Z).
              snapshotUpdatedAt: Date.parse('2026-09-14T12:00:00.000Z') + 60_000,
            },
          });
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        { Records: [{ messageId: 'm1', body: detailBody() }] } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).resolves.toBeUndefined();

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const values = (
      updateCall![0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input.ExpressionAttributeValues;
    expect(values[':quals']).toEqual([]);
  });

  it('throws on a malformed payload (missing qualCode) so SQS retries the batch', async () => {
    const send = vi.fn();
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        {
          Records: [
            {
              messageId: 'm1',
              body: detailBody({}, { qualCode: undefined }),
            },
          ],
        } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow();

    expect(loggedErrors).toHaveBeenCalled();
  });

  it('throws when the DynamoDB snapshot update fails unexpectedly (fail-closed, SQS retry/DLQ)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({});
      }
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.reject(new Error('DynamoDB unavailable'));
      }
      return Promise.resolve({});
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
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

  it('sets memberId on a newly created snapshot item so selector.ts can parse it (P6)', async () => {
    const { send, store } = createStatefulSend();
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [{ messageId: 'm1', body: detailBody({}, { currentlyEligible: true }) }],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(store.get('MEMBER#mbr-1')?.memberId).toBe('mbr-1');
  });

  it('applies both sibling qual changes when two eligibility events for the same member share an identical eventTime (P5, cross-path seam)', async () => {
    const { send, store } = createStatefulSend({
      quals: ['INTERIOR', 'DRIVER'],
      snapshotUpdatedAt: 500,
      memberId: 'mbr-1',
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [
          {
            messageId: 'm1',
            body: detailBody(
              { eventId: 'evt-a', eventTime: '2026-09-14T12:00:00.000Z' },
              { qualCode: 'INTERIOR' },
            ),
          },
          {
            messageId: 'm2',
            body: detailBody(
              { eventId: 'evt-b', eventTime: '2026-09-14T12:00:00.000Z' },
              { qualCode: 'DRIVER' },
            ),
          },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(store.get('MEMBER#mbr-1')?.quals).toEqual([]);
  });

  it('retries the snapshot update after a concurrent-modification conditional failure instead of dropping the change (P7)', async () => {
    const { send, store } = createStatefulSend(
      { quals: ['INTERIOR'], snapshotUpdatedAt: 500, memberId: 'mbr-1' },
      1,
    );
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await handler(
      {
        Records: [
          {
            messageId: 'm1',
            body: detailBody({}, { qualCode: 'DRIVER', currentlyEligible: true }),
          },
        ],
      } as unknown as SQSEvent,
      {} as never,
      () => undefined,
    );

    expect(store.get('MEMBER#mbr-1')?.quals).toEqual(['INTERIOR', 'DRIVER']);
    const updateCalls = send.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('updates an existing snapshot item that has no quals attribute at all instead of exhausting retries (P5 regression)', async () => {
    const { send, store } = createStatefulSend({
      pk: 'x',
      sk: 'MEMBER#mbr-1',
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-1',
      snapshotUpdatedAt: 500,
    });
    const { createHandler } = await import('./eligibilityChangedConsumer.js');
    const handler = createHandler({ client: { send } as unknown as DynamoDBDocumentClient });

    await expect(
      handler(
        {
          Records: [
            {
              messageId: 'm1',
              body: detailBody({}, { qualCode: 'DRIVER', currentlyEligible: true }),
            },
          ],
        } as unknown as SQSEvent,
        {} as never,
        () => undefined,
      ),
    ).resolves.toBeUndefined();

    expect(store.get('MEMBER#mbr-1')?.quals).toEqual(['DRIVER']);
    const updateCalls = send.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCalls.length).toBe(1);
  });
});
