import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-service';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('../dynamoClient.js');
  vi.doUnmock('../channelSender.js');
});

function mockDdb(send: ReturnType<typeof vi.fn>): void {
  vi.doMock('../dynamoClient.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../dynamoClient.js')>();
    return { ...actual, createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient };
  });
}

function mockChannelSender(
  sendPushDigest: ReturnType<typeof vi.fn>,
  sendEmailDigest: ReturnType<typeof vi.fn>,
): void {
  vi.doMock('../channelSender.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channelSender.js')>();
    return { ...actual, sendPushDigest, sendEmailDigest };
  });
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function pendingItem(recipientType: 'MEMBER' | 'ROLE', recipientId: string, certId: string) {
  return { recipientType, recipientId, certId, expiryDate: '2027-01-10' };
}

describe('digestJob handler (entrypoint-test obligation)', () => {
  it('rethrows on a malformed payload, never silently no-oping', async () => {
    const send = vi.fn();
    mockDdb(send);
    const { handler } = await import('./digestJob.js');

    await expect(handler({})).rejects.toThrow('digest job payload failed shape validation');
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops with zero sends when there are no pending items for today', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({ Items: [] });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 0 });
    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
  });

  it('rethrows (fail-closed, zero sends) when the DynamoDB query is unavailable', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = await import('./digestJob.js');

    await expect(handler({ deptId: 'NICHOLS' })).rejects.toThrow('DynamoDB unavailable');
    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('AC1: N cert.expiry.due items for one member on one day collapse into exactly 1 push + 1 email, not N', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({
            Items: [
              pendingItem('MEMBER', 'MBR-1', 'CERT-1'),
              pendingItem('MEMBER', 'MBR-1', 'CERT-2'),
              pendingItem('MEMBER', 'MBR-1', 'CERT-3'),
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { sk: string };
        if (key.sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 1 });
    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
    const items = sendPushDigest.mock.calls[0]?.[2] as unknown[];
    expect(items).toHaveLength(3);
  });

  it('AC4: a muted member gets zero push/email but the NOTIFICATION item is still written', async () => {
    const transactItems: unknown[] = [];
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as { sk: string };
        if (key.sk === 'METADATA') {
          return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
        }
        return Promise.resolve({
          Item: { memberId: 'MBR-1', category: 'cert-expiry', muted: true, updatedAt: 1 },
        });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactItems.push(command.input.TransactItems);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await handler({ deptId: 'NICHOLS' });

    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
    expect(transactItems).toHaveLength(1);
    const items = transactItems[0] as { Put?: { Item: Record<string, unknown> } }[];
    const notificationPut = items.find((item) => item.Put?.Item.entityType === 'NOTIFICATION');
    expect(notificationPut).toBeDefined();
  });

  it('AC2: the training officer digest is delivered unconditionally, never gated on the member preference path', async () => {
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('ROLE', 'TRAINING', 'CERT-1')] });
        }
        return Promise.resolve({
          Items: [
            { memberId: 'OFFICER-1', roles: ['MEMBER', 'TRAINING'], email: 'officer1@example.com' },
          ],
        });
      }
      if (command.constructor.name === 'GetCommand') {
        throw new Error('preference should never be read on the officer path');
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn().mockResolvedValue(undefined);
    const sendEmailDigest = vi.fn().mockResolvedValue(undefined);
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    const result = await handler({ deptId: 'NICHOLS' });

    expect(result).toEqual({ processed: 1 });
    expect(sendPushDigest).toHaveBeenCalledTimes(1);
    expect(sendEmailDigest).toHaveBeenCalledTimes(1);
    expect(sendPushDigest.mock.calls[0]?.[1]).toEqual({
      memberId: 'OFFICER-1',
      email: 'officer1@example.com',
    });
  });

  it('skips a recipient whose digest was already sent today (guard-transact idempotency)', async () => {
    const conditionalFailure = Object.assign(new Error('already sent'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockImplementation((command: CommandLike) => {
      if (command.constructor.name === 'QueryCommand') {
        const gsi3pk = command.input.ExpressionAttributeValues as { ':gsi3pk': string };
        if (gsi3pk[':gsi3pk'].includes('DIGEST_PENDING')) {
          return Promise.resolve({ Items: [pendingItem('MEMBER', 'MBR-1', 'CERT-1')] });
        }
        return Promise.resolve({ Items: [] });
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { email: 'mbr1@example.com' } });
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        return Promise.reject(conditionalFailure);
      }
      return Promise.resolve({});
    });
    mockDdb(send);
    const sendPushDigest = vi.fn();
    const sendEmailDigest = vi.fn();
    mockChannelSender(sendPushDigest, sendEmailDigest);
    const { handler } = await import('./digestJob.js');

    await handler({ deptId: 'NICHOLS' });

    expect(sendPushDigest).not.toHaveBeenCalled();
    expect(sendEmailDigest).not.toHaveBeenCalled();
  });
});
