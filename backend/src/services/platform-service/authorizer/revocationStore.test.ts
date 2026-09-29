import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readRevokedAt, writeRevocationMarker } from './revocationStore.js';

function fakeDoc(item?: Record<string, unknown>): {
  client: DynamoDBDocumentClient;
  inputs: Array<Record<string, unknown>>;
} {
  const inputs: Array<Record<string, unknown>> = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      inputs.push(command.input);
      return Promise.resolve({ Item: item });
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, inputs };
}

describe('revocationStore', () => {
  it('writes a department-scoped marker with revokedAt in epoch seconds', async () => {
    const { client, inputs } = fakeDoc();

    const revokedAt = await writeRevocationMarker(
      client,
      'tbl',
      { deptId: 'NICHOLS', sub: 'sub-1', reason: 'DEVICE_LOSS', actorId: 'admin-1' },
      1_700_000_000_999,
    );

    expect(revokedAt).toBe(1_700_000_000);
    expect(inputs[0]).toMatchObject({
      TableName: 'tbl',
      Item: {
        pk: 'DEPT#NICHOLS#SESSION_REVOCATION#sub-1',
        sk: 'METADATA',
        revokedAt: 1_700_000_000,
        reason: 'DEVICE_LOSS',
        actorId: 'admin-1',
      },
    });
  });

  it('reads revokedAt back, or undefined when the member was never revoked', async () => {
    await expect(readRevokedAt(fakeDoc({ revokedAt: 42 }).client, 't', 'N', 's')).resolves.toBe(42);
    await expect(readRevokedAt(fakeDoc(undefined).client, 't', 'N', 's')).resolves.toBeUndefined();
  });

  it('refuses a deptId or sub carrying the pk delimiter', async () => {
    await expect(readRevokedAt(fakeDoc().client, 't', 'A#B', 's')).rejects.toThrow("'#'");
    await expect(readRevokedAt(fakeDoc().client, 't', 'A', 's#x')).rejects.toThrow("'#'");
  });
});
