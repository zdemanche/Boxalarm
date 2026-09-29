import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  MAX_PUSH_DEVICES,
  parseDeviceId,
  withRegisteredDevice,
  withoutDevice,
  writePushDevices,
  type ContactChannelEntry,
} from './pushDevices.js';

const phone = {
  channel: 'PUSH',
  platform: 'APNS',
  token: 'tok-phone',
  deviceId: 'phone',
  registeredAt: 1,
};
const tablet = {
  channel: 'PUSH',
  platform: 'FCM',
  token: 'tok-tablet',
  deviceId: 'tablet',
  registeredAt: 2,
};
const legacy = { channel: 'PUSH', platform: 'APNS', token: 'tok-legacy', registeredAt: 0 };

describe('push devices: one PUSH entry per app installation', () => {
  it('signing in on a tablet adds a device; the phone keeps being paged', () => {
    expect(withRegisteredDevice([phone], { ...tablet, registeredAt: 3 })).toEqual([
      { ...tablet, registeredAt: 3 },
      phone,
    ]);
  });

  it('a device rotating its token replaces only its own entry', () => {
    const rotated = { ...phone, token: 'tok-phone-2', registeredAt: 5 };
    expect(withRegisteredDevice([phone, tablet], rotated)).toEqual([rotated, tablet]);
  });

  it('a legacy (no deviceId) registration replaces only the legacy entry', () => {
    const next = { ...legacy, token: 'tok-legacy-2', registeredAt: 9 };
    expect(withRegisteredDevice([legacy, phone], next)).toEqual([next, phone]);
  });

  it('an app that starts sending its deviceId replaces its own legacy entry (same token)', () => {
    const upgraded = { ...legacy, deviceId: 'phone-2', registeredAt: 4 };
    expect(withRegisteredDevice([legacy, tablet], upgraded)).toEqual([upgraded, tablet]);
  });

  it('keeps non-push entries and caps devices at the newest MAX_PUSH_DEVICES', () => {
    const others: ContactChannelEntry[] = [{ channel: 'SMS', token: '+1' }];
    const many = Array.from({ length: MAX_PUSH_DEVICES }, (_, i) => ({
      channel: 'PUSH',
      token: `tok-${i}`,
      deviceId: `d-${i}`,
      registeredAt: 100 + i,
    }));
    const result = withRegisteredDevice([...others, ...many], {
      channel: 'PUSH',
      token: 'tok-new',
      deviceId: 'd-new',
      registeredAt: 1000,
    });
    expect(result[0]).toEqual(others[0]);
    const devices = result.filter((entry) => entry.channel === 'PUSH');
    expect(devices).toHaveLength(MAX_PUSH_DEVICES);
    expect(devices.map((entry) => entry.deviceId)).not.toContain('d-0');
    expect(devices[0]?.deviceId).toBe('d-new');
  });

  it("sign-out removes only that device's entry", () => {
    expect(withoutDevice([phone, tablet, legacy], 'tablet')).toEqual([phone, legacy]);
  });

  it('a legacy sign-out (no deviceId) removes only the legacy entry', () => {
    expect(withoutDevice([phone, tablet, legacy], undefined)).toEqual([phone, tablet]);
  });

  it.each([['has#hash'], [''], ['x'.repeat(129)], [42]])('rejects deviceId %j', (value) => {
    expect(() => parseDeviceId(value)).toThrow('deviceId');
  });

  it('accepts a UUID-style installation id and treats absence as legacy', () => {
    expect(parseDeviceId('0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d')).toBe(
      '0b6f1c2e-5d0a-4d9e-9b51-1c2f3a4b5c6d',
    );
    expect(parseDeviceId(undefined)).toBeUndefined();
  });
});

describe('writePushDevices: concurrent registrations never drop each other', () => {
  it('re-reads and re-applies the change when another device registered in between', async () => {
    let gets = 0;
    let writes = 0;
    const send = vi.fn(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'GetCommand') {
          gets += 1;
          return Promise.resolve({
            Item:
              gets === 1
                ? { contactChannels: [phone], updatedAt: 10 }
                : { contactChannels: [phone, tablet], updatedAt: 11 },
          });
        }
        writes += 1;
        if (writes === 1) {
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
    );

    const laptop = { channel: 'PUSH', token: 'tok-laptop', deviceId: 'laptop', registeredAt: 12 };
    await expect(
      writePushDevices(
        { send } as unknown as DynamoDBDocumentClient,
        'tbl',
        toVerifiedDeptId({ deptId: 'NICHOLS' }),
        'mbr-1',
        (current) => withRegisteredDevice(current, laptop),
      ),
    ).resolves.toBe('written');

    const transacts = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === 'TransactWriteCommand');
    const last = transacts.at(-1)!.input as {
      TransactItems: [
        {
          Update: {
            ConditionExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        },
        { Put: { Item: { payload: { contactChannels: unknown[] } } } },
      ];
    };
    expect(last.TransactItems[0].Update.ConditionExpression).toBe(
      'attribute_exists(pk) AND updatedAt = :previousUpdatedAt',
    );
    expect(last.TransactItems[0].Update.ExpressionAttributeValues[':previousUpdatedAt']).toBe(11);
    // The tablet that registered meanwhile survives, and the event carries all three devices.
    expect(last.TransactItems[1].Put.Item.payload.contactChannels).toEqual([laptop, tablet, phone]);
  });

  it('reports not_found for a member that does not exist', async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      writePushDevices(
        { send } as unknown as DynamoDBDocumentClient,
        'tbl',
        toVerifiedDeptId({ deptId: 'NICHOLS' }),
        'mbr-1',
        (current) => [...current],
      ),
    ).resolves.toBe('not_found');
  });
});
