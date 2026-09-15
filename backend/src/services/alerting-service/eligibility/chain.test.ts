import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function applyUpdate(
  items: Map<string, FakeItem>,
  key: { pk: string; sk: string },
  updateExpression: string,
  values: Record<string, unknown>,
): void {
  const mapKey = `${key.pk}#${key.sk}`;
  const existing: FakeItem = items.get(mapKey) ?? { pk: key.pk, sk: key.sk };
  for (const assignment of updateExpression.replace(/^SET /, '').split(',')) {
    const [field, valueRef] = assignment.split('=').map((part) => part.trim());
    if (field && valueRef) {
      existing[field] = values[valueRef];
    }
  }
  items.set(mapKey, existing);
}

function createFakeDdb(seed: readonly FakeItem[] = []): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'TransactWriteCommand') {
      for (const txItem of input.TransactItems as ReadonlyArray<Record<string, unknown>>) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
        if (txItem.Update) {
          const update = txItem.Update as {
            Key: { pk: string; sk: string };
            UpdateExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
          applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
        }
      }
      return {};
    }
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: items.get(`${key.pk}#${key.sk}`) };
    }
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
      return {};
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, string> };
      return {
        Items: [...items.values()].filter(
          (item) => item.pk === query.ExpressionAttributeValues[':pk'],
        ),
      };
    }
    throw new Error(`chain.test.ts fake ddb: unsupported command ${name}`);
  });
  return { send: send as unknown as DynamoDBDocumentClient['send'], items };
}

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const NOW = Math.floor(Date.now() / 1000);

describe('E2-S5 chain: markoff creation suppresses fan-out eligibility and reversion restores it (F2.5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
    process.env.PLATFORM_TABLE_NAME = 'platform-table';
    process.env.AVAILABILITY_EXPIRY_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:expiry';
    process.env.AVAILABILITY_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('drives handler -> outbox -> publisher -> consumer -> selector for a member marking off now, then expiryHandler -> outbox -> publisher -> consumer -> selector for reversion at window end', async () => {
    const personnel = createFakeDdb();
    const alerting = createFakeDdb([
      {
        pk: 'DEPT#NICHOLS#ELIGIBILITY',
        sk: 'MEMBER#mbr-1',
        entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
        memberId: 'mbr-1',
        active: true,
        quals: [],
        roles: [],
        availabilityState: 'AVAILABLE',
        snapshotUpdatedAt: NOW - 10_000,
      },
    ]);

    vi.doMock('../../personnel-service/availability/dynamoClient.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../../personnel-service/availability/dynamoClient.js')
        >();
      return {
        ...actual,
        createDdbClient: () => ({ send: personnel.send }) as unknown as DynamoDBDocumentClient,
      };
    });
    vi.doMock('./dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./dynamoClient.js')>();
      return {
        ...actual,
        createDdbClient: () => ({ send: alerting.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const { createAvailability } = await import('../../personnel-service/availability/handler.js');
    const { handler: expiryHandler } =
      await import('../../personnel-service/availability/expiryHandler.js');
    const { handler: publish } = await import('../../personnel-service/outbox/publisher.js');
    const { handler: consume } = await import('./consumer.js');
    const { queryEligibleMembers } = await import('./selector.js');

    const startAt = NOW - 60;
    const endAt = NOW + 3600;
    const createEvent = {
      pathParameters: { memberId: 'mbr-1' },
      headers: {},
      body: JSON.stringify({ startAt, endAt, reason: 'Vacation' }),
    } as unknown as GuardEvent;

    const schedulerSend = vi.fn().mockResolvedValue({});
    const createResult = await createAvailability(
      createEvent,
      { sub: 'mbr-1', deptId: 'NICHOLS' },
      { schedulerClient: { send: schedulerSend } as unknown as SchedulerClient },
    );
    expect(createResult).toMatchObject({ statusCode: 201 });

    const outboxEntry = [...personnel.items.values()].find(
      (item) => item.entityType === 'OUTBOX_ENTRY',
    );
    expect(outboxEntry).toBeDefined();

    const publishedDetails: string[] = [];
    const ebSend = vi.fn((command: { input: { Entries: Array<{ Detail: string }> } }) => {
      for (const entry of command.input.Entries) {
        publishedDetails.push(entry.Detail);
      }
      return Promise.resolve({ Entries: command.input.Entries.map(() => ({})) });
    });

    const streamEvent = {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              pk: { S: outboxEntry!.pk },
              sk: { S: outboxEntry!.sk },
              entityType: { S: 'OUTBOX_ENTRY' },
              eventId: { S: outboxEntry!.eventId as string },
              eventType: { S: 'personnel.availability.changed' },
              correlationId: { S: 'mbr-1' },
              createdAt: { N: String(outboxEntry!.createdAt) },
              payload: {
                M: {
                  deptId: { S: 'NICHOLS' },
                  memberId: { S: 'mbr-1' },
                  availabilityState: { S: 'MARKED_OFF' },
                },
              },
            },
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    await publish(streamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(1);
    const markedOffEnvelope = JSON.parse(publishedDetails[0]!) as {
      eventId: string;
      eventTime: string;
    };
    expect(markedOffEnvelope).toMatchObject({
      eventType: 'personnel.availability.changed',
      source: 'personnel-service',
      correlationId: 'mbr-1',
      schemaVersion: '1.0',
    });
    expect(typeof markedOffEnvelope.eventId).toBe('string');
    expect(typeof markedOffEnvelope.eventTime).toBe('string');

    await consume({
      Records: [{ messageId: 'm1', body: publishedDetails[0]! }],
    } as unknown as SQSEvent);

    const eligibleWhileMarkedOff = await queryEligibleMembers(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(eligibleWhileMarkedOff.map((m) => m.memberId)).not.toContain('mbr-1');

    const revertResult = await expiryHandler({
      deptId: 'NICHOLS',
      memberId: 'mbr-1',
      startAt,
      action: 'REVERT',
    });
    expect(revertResult).toEqual({ outcome: 'REVERTED' });

    const revertOutboxEntry = [...personnel.items.values()]
      .filter((item) => item.entityType === 'OUTBOX_ENTRY')
      .find(
        (item) => (item.payload as { availabilityState: string }).availabilityState === 'AVAILABLE',
      );
    expect(revertOutboxEntry).toBeDefined();

    const revertStreamEvent = {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              pk: { S: revertOutboxEntry!.pk },
              sk: { S: revertOutboxEntry!.sk },
              entityType: { S: 'OUTBOX_ENTRY' },
              eventId: { S: revertOutboxEntry!.eventId as string },
              eventType: { S: 'personnel.availability.changed' },
              correlationId: { S: 'mbr-1' },
              createdAt: { N: String(revertOutboxEntry!.createdAt) },
              payload: {
                M: {
                  deptId: { S: 'NICHOLS' },
                  memberId: { S: 'mbr-1' },
                  availabilityState: { S: 'AVAILABLE' },
                },
              },
            },
          },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    await publish(revertStreamEvent, {
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
    });
    expect(publishedDetails).toHaveLength(2);

    await consume({
      Records: [{ messageId: 'm2', body: publishedDetails[1]! }],
    } as unknown as SQSEvent);

    const eligibleAfterRevert = await queryEligibleMembers(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(eligibleAfterRevert.map((m) => m.memberId)).toContain('mbr-1');
  });
});
