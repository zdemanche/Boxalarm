import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DeliverChannelMessageParams } from './deliverChannelMessage.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function mockAdapter(sendViaHttpProvider: ReturnType<typeof vi.fn>): void {
  vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
}

const baseParams: DeliverChannelMessageParams = {
  deptId,
  dispatchId: 'dispatch-1',
  memberId: 'mbr-1',
  channel: 'push',
  toneSequence: 1,
  contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }],
  message: 'structure-fire — 12 Main St',
  env: {},
};

afterEach(() => {
  vi.resetModules();
});

describe('deliverChannelMessage', () => {
  it('writes an immutable DELIVERY_RECEIPT keyed by dispatch/member/channel/tone, then sends via the adapter', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(send).toHaveBeenCalledTimes(1);
    const putInput = (send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } })
      .input;
    expect(putInput.Item.pk).toBe('DEPT#NICHOLS#DISPATCH#dispatch-1');
    expect(putInput.Item.sk).toBe('RECEIPT#mbr-1#PUSH#1');
    expect(putInput.Item.idempotencyKey).toBe('dispatch-1#1#mbr-1#PUSH');
    expect(putInput.Item.gsi1pk).toBe('MEMBER#mbr-1');
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'push',
      'tok-1',
      baseParams.message,
      baseParams.env,
    );
  });

  it('no-ops without calling the provider when the idempotency key already exists (duplicate skip)', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('skips without a put when no target is registered for the channel', async () => {
    const send = vi.fn();
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', {
      ...baseParams,
      contactChannels: [],
    });

    expect(send).not.toHaveBeenCalled();
    expect(sendViaHttpProvider).not.toHaveBeenCalled();
  });

  it('logs the original error and rethrows when the provider adapter throws (no swallow, DLQ redrive takes over)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sendViaHttpProvider = vi.fn().mockRejectedValue(new Error('push provider down'));
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs the original error and rethrows when the receipt write itself fails for a non-duplicate reason', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const sendViaHttpProvider = vi.fn();
    mockAdapter(sendViaHttpProvider);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(sendViaHttpProvider).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
