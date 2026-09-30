import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import { invalidatePushToken } from './invalidatePushToken.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function snapshotWith(pushEntry: Record<string, unknown>) {
  const send = vi.fn((command: { constructor: { name: string } }) =>
    Promise.resolve(
      command.constructor.name === 'GetCommand'
        ? { Item: { snapshotUpdatedAt: 1, contactChannels: [pushEntry] } }
        : {},
    ),
  );
  return { client: { send } as unknown as DynamoDBDocumentClient, send };
}

const updates = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
  );

describe('invalidatePushToken — the APNs 410 race (review minor 1)', () => {
  const invalidSinceMs = 1_798_000_000_000;

  it('invalidates an entry registered before APNs last saw the token invalid', async () => {
    const table = snapshotWith({ channel: 'PUSH', token: 'tok', registeredAt: invalidSinceMs - 1 });
    await expect(
      invalidatePushToken(table.client, 't', deptId, 'mbr-1', 'tok', { invalidSinceMs }),
    ).resolves.toBe('invalidated');
    expect(updates(table.send)).toHaveLength(1);
  });

  it('leaves alone an entry the device re-registered after the 410 timestamp', async () => {
    const table = snapshotWith({ channel: 'PUSH', token: 'tok', registeredAt: invalidSinceMs + 5 });
    await expect(
      invalidatePushToken(table.client, 't', deptId, 'mbr-1', 'tok', { invalidSinceMs }),
    ).resolves.toBe('reregistered');
    expect(updates(table.send)).toHaveLength(0);
  });

  it('without a 410 timestamp (BadDeviceToken, FCM) invalidates regardless of registeredAt', async () => {
    const table = snapshotWith({ channel: 'PUSH', token: 'tok', registeredAt: invalidSinceMs + 5 });
    await expect(invalidatePushToken(table.client, 't', deptId, 'mbr-1', 'tok')).resolves.toBe(
      'invalidated',
    );
  });

  it('an entry with no registeredAt is invalidated (legacy snapshot)', async () => {
    const table = snapshotWith({ channel: 'PUSH', token: 'tok' });
    await expect(
      invalidatePushToken(table.client, 't', deptId, 'mbr-1', 'tok', { invalidSinceMs }),
    ).resolves.toBe('invalidated');
  });
});

describe('invalidatePushToken — concurrency with the contact projection', () => {
  it('guards on contactVersion and advances it, so a concurrent registration or phone change is never overwritten', async () => {
    const send = vi.fn((command: { constructor: { name: string } }) =>
      Promise.resolve(
        command.constructor.name === 'GetCommand'
          ? { Item: { contactVersion: 3, contactChannels: [{ channel: 'PUSH', token: 'tok' }] } }
          : {},
      ),
    );
    await invalidatePushToken(
      { send } as unknown as DynamoDBDocumentClient,
      't',
      deptId,
      'mbr-1',
      'tok',
    );
    const input = (updates(send)[0]?.[0] as { input: Record<string, unknown> }).input;
    expect(input.ConditionExpression).toBe('attribute_exists(pk) AND contactVersion = :version');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':version': 3, ':nextVersion': 4 });
  });
});

describe('invalidatePushToken — multi-device', () => {
  it("invalidates only the dead device's entry; the member's other devices stay valid", async () => {
    const phone = { channel: 'PUSH', token: 'tok-phone', deviceId: 'phone', valid: true };
    const tablet = { channel: 'PUSH', token: 'tok-tablet', deviceId: 'tablet', valid: true };
    const send = vi.fn((command: { constructor: { name: string } }) =>
      Promise.resolve(
        command.constructor.name === 'GetCommand'
          ? { Item: { contactVersion: 1, contactChannels: [phone, tablet] } }
          : {},
      ),
    );
    await expect(
      invalidatePushToken(
        { send } as unknown as DynamoDBDocumentClient,
        't',
        deptId,
        'mbr-1',
        'tok-tablet',
      ),
    ).resolves.toBe('invalidated');
    const input = (updates(send)[0]?.[0] as { input: { ExpressionAttributeValues: unknown } })
      .input;
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':contactChannels': [phone, { ...tablet, valid: false }],
    });
  });
});
