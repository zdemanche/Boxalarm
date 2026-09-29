import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readMemberStatus, readPlatformTableName } from './memberAccessStore.js';

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
