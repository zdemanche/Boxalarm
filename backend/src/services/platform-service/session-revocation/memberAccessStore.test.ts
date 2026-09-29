import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  invalidateMemberPush,
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

    await expect(invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 'trace-1')).resolves.toBe(
      'invalidated',
    );

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
      payload: { memberId: 'sub-1', deptId: 'NICHOLS', contactChannels: remaining },
    });
  });

  it('writes nothing when the member has no PUSH entry', async () => {
    const { client, commands } = docWith({ contactChannels: [{ channel: 'SMS' }] });

    await expect(invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't')).resolves.toBe(
      'no-push-entry',
    );
    expect(commands.map((c) => c.name)).toEqual(['GetCommand']);
  });

  it('writes nothing when the member row does not exist', async () => {
    const { client, commands } = docWith(undefined);

    await expect(invalidateMemberPush(client, 'tbl', 'NICHOLS', 'sub-1', 't')).resolves.toBe(
      'no-member',
    );
    expect(commands).toHaveLength(1);
  });
});
