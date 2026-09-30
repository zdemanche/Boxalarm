import { describe, expect, it } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  invalidateMemberPush,
  listMemberDevices,
  readMemberStatus,
  readPlatformTableName,
} from './memberAccessStore.js';

function fakeDoc(item: Record<string, unknown> | undefined): {
  client: DynamoDBDocumentClient;
  inputs: unknown[];
} {
  const inputs: unknown[] = [];
  const client = {
    send: (command: { input: unknown }) => {
      inputs.push(command.input);
      return Promise.resolve({ Item: item });
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, inputs };
}

describe('readPlatformTableName', () => {
  it('throws when PLATFORM_TABLE_NAME is unset', () => {
    expect(() => readPlatformTableName({})).toThrow('PLATFORM_TABLE_NAME is required');
  });
});

describe('readMemberStatus', () => {
  it('reads the department-scoped member row with a consistent read', async () => {
    const { client, inputs } = fakeDoc({ status: 'LOA' });

    await expect(readMemberStatus(client, 'tbl', 'NICHOLS', 'sub-1')).resolves.toBe('LOA');
    expect(inputs[0]).toMatchObject({
      TableName: 'tbl',
      Key: { pk: 'DEPT#NICHOLS#MEMBER#sub-1', sk: 'METADATA' },
      ConsistentRead: true,
    });
  });

  it('returns undefined when the member has no row', async () => {
    const { client } = fakeDoc(undefined);

    await expect(readMemberStatus(client, 'tbl', 'NICHOLS', 'sub-1')).resolves.toBeUndefined();
  });

  it('refuses a deptId carrying the pk delimiter', async () => {
    const { client } = fakeDoc(undefined);

    await expect(readMemberStatus(client, 'tbl', 'A#B', 'sub-1')).rejects.toThrow("'#'");
  });
});

describe('invalidateMemberPush (M2)', () => {
  function docWith(item: Record<string, unknown> | undefined): {
    client: DynamoDBDocumentClient;
    commands: Array<{ name: string; input: Record<string, unknown> }>;
  } {
    const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        commands.push({ name: command.constructor.name, input: command.input });
        return Promise.resolve(command.constructor.name === 'GetCommand' ? { Item: item } : {});
      },
    } as unknown as DynamoDBDocumentClient;
    return { client, commands };
  }

  it('drops only the PUSH channel and emits personnel.member.updated with the new channels', async () => {
    const { client, commands } = docWith({
      contactChannels: [
        { channel: 'PUSH', platform: 'APNS', token: 'tok-lost', valid: true },
        { channel: 'SMS', token: '+15551234567', valid: true },
      ],
    });

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 'trace-1', 'admin-1'),
    ).resolves.toBe('invalidated');

    const transact = commands.find((c) => c.name === 'TransactWriteCommand');
    const items = transact?.input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    const remaining = [{ channel: 'SMS', token: '+15551234567', valid: true }];
    expect(items[0]?.Update).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#MEMBER#sub-1', sk: 'METADATA' },
      ExpressionAttributeValues: { ':cc': remaining },
    });
    expect(items[1]?.Put?.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#OUTBOX#sub-1',
      eventType: 'personnel.member.updated',
      source: 'personnel-service',
      payload: {
        memberId: 'sub-1',
        deptId: 'NICHOLS',
        contactChannels: remaining,
        // Review minor 9: the real producer and actor, since `source` must read personnel-service.
        changedBy: { service: 'platform-service', reason: 'DEVICE_LOSS', actorId: 'admin-1' },
      },
    });
  });

  it('writes nothing when the member has no PUSH entry', async () => {
    const { client, commands } = docWith({ contactChannels: [{ channel: 'SMS' }] });

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1'),
    ).resolves.toBe('no-push-entry');
    expect(commands.map((c) => c.name)).toEqual(['GetCommand']);
  });

  it('writes nothing when the member row does not exist', async () => {
    const { client, commands } = docWith(undefined);

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1'),
    ).resolves.toBe('no-member');
    expect(commands).toHaveLength(1);
  });

  it('treats the channel name case-insensitively (review minor 5)', async () => {
    const { client, commands } = docWith({
      updatedAt: 5,
      contactChannels: [{ channel: 'push', token: 't' }, { channel: 'Sms' }],
    });

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1'),
    ).resolves.toBe('invalidated');
    const transact = commands.find((c) => c.name === 'TransactWriteCommand');
    const items = transact?.input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    expect(items[0]?.Update).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND updatedAt = :previousUpdatedAt',
      ExpressionAttributeValues: { ':cc': [{ channel: 'Sms' }], ':previousUpdatedAt': 5 },
    });
  });

  it('re-reads and re-applies the filter when a concurrent write changed the row', async () => {
    const reads = [
      { updatedAt: 1, contactChannels: [{ channel: 'PUSH', token: 'old' }] },
      {
        updatedAt: 2,
        contactChannels: [{ channel: 'PUSH', token: 'new' }, { channel: 'SMS' }],
      },
    ];
    let transacts = 0;
    const inputs: Array<Record<string, unknown>> = [];
    const client = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'GetCommand') {
          return Promise.resolve({ Item: reads.shift() });
        }
        transacts += 1;
        inputs.push(command.input);
        if (transacts === 1) {
          return Promise.reject(
            new TransactionCanceledException({
              message: 'cancelled',
              $metadata: {},
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            }),
          );
        }
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1'),
    ).resolves.toBe('invalidated');
    const second = (inputs[1]?.TransactItems as Array<Record<string, Record<string, unknown>>>)[0];
    expect(second?.Update).toMatchObject({
      ExpressionAttributeValues: { ':cc': [{ channel: 'SMS' }], ':previousUpdatedAt': 2 },
    });
  });

  it('gives up after three conflicting attempts', async () => {
    const client = {
      send: (command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetCommand'
          ? Promise.resolve({ Item: { updatedAt: 1, contactChannels: [{ channel: 'PUSH' }] } })
          : Promise.reject(
              new TransactionCanceledException({
                message: 'cancelled',
                $metadata: {},
                CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
              }),
            ),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1'),
    ).rejects.toThrow('lost a repeated write race');
  });

  // Integration item 1: device loss is personnel's writePushDevices - the same event time rule
  // as a registration, so an invalidation stamped in the same millisecond is never stale.
  it("stamps the event after the row's last write (max(now, updatedAt + 1)) and keeps the caller's correlationId", async () => {
    const future = Date.now() + 60_000;
    const { client, commands } = docWith({
      updatedAt: future,
      contactChannels: [{ channel: 'PUSH', token: 't', deviceId: 'phone' }],
    });

    await invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 'trace-9', 'admin-1');

    const transact = commands.find((c) => c.name === 'TransactWriteCommand');
    const items = transact?.input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ':ts': future + 1 });
    expect(items[1]?.Put?.Item).toMatchObject({
      eventTime: new Date(future + 1).toISOString(),
      correlationId: 'trace-9',
    });
  });

  // Integration item 2: the admin identified the lost device - only it stops receiving pages.
  it('removes only the identified device when a deviceId is given', async () => {
    const { client, commands } = docWith({
      updatedAt: 3,
      contactChannels: [
        { channel: 'PUSH', token: 'tok-phone', deviceId: 'phone' },
        { channel: 'PUSH', token: 'tok-tablet', deviceId: 'tablet' },
        { channel: 'SMS', token: '+15551234567' },
      ],
    });

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1', 'phone'),
    ).resolves.toBe('invalidated');

    const transact = commands.find((c) => c.name === 'TransactWriteCommand');
    const items = transact?.input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    const remaining = [
      { channel: 'PUSH', token: 'tok-tablet', deviceId: 'tablet' },
      { channel: 'SMS', token: '+15551234567' },
    ];
    expect(items[0]?.Update?.ExpressionAttributeValues).toMatchObject({ ':cc': remaining });
    expect(items[1]?.Put?.Item).toMatchObject({
      payload: {
        contactChannels: remaining,
        changedBy: {
          service: 'platform-service',
          reason: 'DEVICE_LOSS',
          actorId: 'admin-1',
          deviceId: 'phone',
        },
      },
    });
  });

  it('writes nothing when the identified device is already gone', async () => {
    const { client, commands } = docWith({
      updatedAt: 3,
      contactChannels: [{ channel: 'PUSH', token: 'tok-tablet', deviceId: 'tablet' }],
    });

    await expect(
      invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't', 'admin-1', 'phone'),
    ).resolves.toBe('no-push-entry');
    expect(commands.map((c) => c.name)).toEqual(['GetCommand']);
  });
});

describe('listMemberDevices', () => {
  it('lists push devices newest first, without their tokens', async () => {
    const { client, inputs } = fakeDoc({
      contactChannels: [
        {
          channel: 'PUSH',
          platform: 'APNS',
          token: 'secret-1',
          deviceId: 'phone',
          registeredAt: 1,
        },
        { channel: 'SMS', token: '+15551234567' },
        {
          channel: 'push',
          platform: 'FCM',
          token: 'secret-2',
          deviceId: 'tablet',
          registeredAt: 2,
          valid: false,
        },
        { channel: 'PUSH', platform: 'APNS', token: 'secret-3' },
      ],
    });

    const devices = await listMemberDevices(client, 'tbl', 'NICHOLS', 'sub-1');

    expect(devices).toEqual([
      { deviceId: 'tablet', platform: 'FCM', registeredAt: 2, valid: false },
      { deviceId: 'phone', platform: 'APNS', registeredAt: 1, valid: true },
      { deviceId: null, platform: 'APNS', registeredAt: null, valid: true },
    ]);
    expect(JSON.stringify(devices)).not.toContain('secret');
    expect(inputs[0]).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#MEMBER#sub-1', sk: 'METADATA' },
      ConsistentRead: true,
    });
  });

  it('returns undefined when the member has no row in the department', async () => {
    const { client } = fakeDoc(undefined);

    await expect(listMemberDevices(client, 'tbl', 'NICHOLS', 'sub-1')).resolves.toBeUndefined();
  });
});
