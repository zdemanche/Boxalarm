import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DeliverChannelMessageParams } from './deliverChannelMessage.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDdb(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

/**
 * The send-guard tests below run on the push channel, so they drive the direct APNs/FCM
 * gateway (sendPush) itself. The generic SMS/voice adapter is mocked to throw so a push that
 * regressed onto it fails loudly instead of passing through a shared spy.
 */
function mockAdapter(sendPush: ReturnType<typeof vi.fn>): void {
  vi.doMock('./httpProviderAdapter.js', () => ({
    sendPush: vi.fn().mockRejectedValue(new Error('push must not use the HTTP adapter')),
  }));
  vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
    sendPush,
  }));
}

/** What sendPush receives for baseParams: tok-1 has no platform and is not hex → FCM. */
function expectedPushCall(isTest = false): [unknown, string, object, { isTest: boolean }] {
  const notification: unknown = expect.objectContaining({
    token: 'tok-1',
    body: 'structure-fire — 12 Main St',
    idempotencyKey: 'dispatch-1#1#mbr-1#PUSH',
  });
  return [notification, 'FCM', {}, { isTest }];
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
  vi.doUnmock('./httpProviderAdapter.js');
  vi.doUnmock('./push/pushProviderAdapter.js');
  vi.resetModules();
});

describe('deliverChannelMessage', () => {
  it('writes an immutable DELIVERY_RECEIPT keyed by dispatch/member/channel/tone, then sends via the adapter', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockAdapter(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    // The claim, then SENT once the provider accepted it.
    expect(send).toHaveBeenCalledTimes(2);
    const putInput = (send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } })
      .input;
    expect(putInput.Item.sendState).toBe('CLAIMED');
    expect(
      (send.mock.calls[1]?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } })
        .input.ExpressionAttributeValues,
    ).toEqual({
      ':sent': 'SENT',
      ':completedAtMs': expect.any(Number) as number,
      // Per-device outcome under the one per-channel guard (multi-device push).
      ':deviceSends': { 'token-65dcf16ea3dfa490': 'SENT' },
    });
    expect(putInput.Item.pk).toBe('DEPT#NICHOLS#DISPATCH#dispatch-1');
    expect(putInput.Item.sk).toBe('RECEIPT#mbr-1#PUSH#1');
    expect(putInput.Item.idempotencyKey).toBe('dispatch-1#1#mbr-1#PUSH');
    expect(putInput.Item.gsi1pk).toBe('MEMBER#mbr-1');
    expect(putInput.Item.sentAt).toBeLessThan(10_000_000_000);
    expect(putInput.Item.gsi1sk).toBe(`RECEIPT#${putInput.Item.sentAt as number}#dispatch-1`);
    expect(sendPush).toHaveBeenCalledWith(...expectedPushCall());
  });

  it('no-ops without calling the provider when the idempotency key already exists for a prior successful attempt (duplicate skip)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { failureReason: null, deliveredAt: null } });
      }
      return Promise.resolve({});
    });
    const sendPush = vi.fn();
    mockAdapter(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendPush).not.toHaveBeenCalled();
  });

  it('skips without a put when no target is registered for the channel', async () => {
    const send = vi.fn();
    const sendPush = vi.fn();
    mockAdapter(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', {
      ...baseParams,
      contactChannels: [],
    });

    expect(send).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('logs the original error, records failureReason on the claimed receipt, and rethrows when the provider adapter throws (no swallow, DLQ redrive takes over)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const sendPush = vi.fn().mockRejectedValue(new Error('push provider down'));
    mockAdapter(sendPush);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    const updateInput = (
      updateCall?.[0] as { input: { ExpressionAttributeValues: Record<string, unknown> } }
    ).input;
    expect(updateInput.ExpressionAttributeValues[':reason']).toBe('push provider down');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits SendFailed under the Reason=<channel> dimension the infra delivery-failure alarm watches', async () => {
    const send = vi.fn().mockResolvedValue({});
    mockAdapter(vi.fn().mockRejectedValue(new Error('push provider down')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push provider down');

    // infrastructure/components/alerting/alarms.ts alarms on
    // Boxalarm/AlertingChannel SendFailed with dimensions { Reason: channel }.
    const emf = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry !== undefined && 'SendFailed' in entry) as
      | {
          _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
          Reason: string;
        }
      | undefined;
    expect(emf).toBeDefined();
    expect(emf!._aws.CloudWatchMetrics[0]!.Namespace).toBe('Boxalarm/AlertingChannel');
    expect(emf!._aws.CloudWatchMetrics[0]!.Dimensions).toContainEqual(['Reason']);
    expect(emf!.Reason).toBe('push');
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('re-attempts the send on redelivery when the prior claim failed and was never delivered (P8 regression)', async () => {
    const send = vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (name === 'GetCommand') {
        return Promise.resolve({
          Item: { failureReason: 'push provider down', deliveredAt: null },
        });
      }
      return Promise.resolve({});
    });
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockAdapter(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(sendPush).toHaveBeenCalledWith(...expectedPushCall());
    const updateCall = send.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
  });

  describe('a redelivery finding a claim with no failure recorded (review MINOR-R5)', () => {
    const now = () => Math.floor(Date.now() / 1000);

    function claimedGuard(existing: Record<string, unknown>, reclaim: 'ok' | 'lost' = 'ok') {
      return vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === 'PutCommand') {
          return Promise.reject(
            new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
          );
        }
        if (name === 'GetCommand') {
          return Promise.resolve({ Item: existing });
        }
        return reclaim === 'lost'
          ? Promise.reject(new ConditionalCheckFailedException({ message: 'lost', $metadata: {} }))
          : Promise.resolve({});
      });
    }

    it('retakes an abandoned claim (worker died mid-send) and sends', async () => {
      const abandonedAt = now() - 35;
      const send = claimedGuard({
        sendState: 'CLAIMED',
        sentAt: abandonedAt,
        failureReason: null,
        deliveredAt: null,
      });
      const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
      mockAdapter(sendPush);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendPush).toHaveBeenCalledTimes(1);
      const get = send.mock.calls.find(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetCommand',
      )?.[0] as { input: Record<string, unknown> };
      expect(get.input.ConsistentRead).toBe(true);
      const reclaim = send.mock.calls.find(
        (call) =>
          (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
      )?.[0] as { input: { ConditionExpression: string; ExpressionAttributeValues: object } };
      // Optimistic on the exact claim read, so only one of two redeliveries can take it.
      expect(reclaim.input.ConditionExpression).toContain('sentAt = :observedSentAt');
      expect(reclaim.input.ExpressionAttributeValues).toMatchObject({
        ':observedSentAt': abandonedAt,
      });
    });

    it.each([
      ['a fresh claim (a concurrent twin still sending)', { sendState: 'CLAIMED', sentAt: 0 }],
      ['a claim marked SENT', { sendState: 'SENT', sentAt: -100 }],
      ['a claim written before sendState existed', { sentAt: -100 }],
    ])('skips %s as a duplicate', async (_label, guard) => {
      const send = claimedGuard({
        ...guard,
        sentAt: now() + guard.sentAt,
        failureReason: null,
        deliveredAt: null,
      });
      const sendPush = vi.fn();
      mockAdapter(sendPush);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendPush).not.toHaveBeenCalled();
    });

    it('a redelivery that loses the re-claim race does not send', async () => {
      const send = claimedGuard(
        { sendState: 'CLAIMED', sentAt: now() - 35, failureReason: null, deliveredAt: null },
        'lost',
      );
      const sendPush = vi.fn();
      mockAdapter(sendPush);
      const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

      await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

      expect(sendPush).not.toHaveBeenCalled();
    });
  });

  it('logs the original error and rethrows when the receipt write itself fails for a non-duplicate reason', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    const sendPush = vi.fn();
    mockAdapter(sendPush);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(sendPush).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('deliverChannelMessage — direct APNs/FCM push path', () => {
  type SendPushSpy = ReturnType<typeof vi.fn>;

  function mockPush(sendPush: SendPushSpy, sendViaHttpProvider = vi.fn()): void {
    vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider }));
    vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
      sendPush,
    }));
  }

  function commandsNamed(send: ReturnType<typeof vi.fn>, name: string) {
    return send.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((command) => command.constructor.name === name);
  }

  /** Guard claim succeeds; the eligibility snapshot read returns the given push entry. */
  function tableWithSnapshot(pushEntry: Record<string, unknown>) {
    return vi
      .fn()
      .mockImplementation(
        (command: { constructor: { name: string }; input: { Key?: { sk?: string } } }) => {
          // Only the member's eligibility snapshot exists; the guard's latch and window items
          // do not, so the guard admits.
          if (
            command.constructor.name === 'GetCommand' &&
            command.input.Key?.sk === 'MEMBER#mbr-1'
          ) {
            return Promise.resolve({
              Item: { contactChannels: [pushEntry, { channel: 'sms', token: '+12035550100' }] },
            });
          }
          return Promise.resolve({});
        },
      );
  }

  it('builds a critical dispatch push with a per-tone collapse key and the exactly-once idempotency key, routed by the registered platform', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      toneSequence: 2,
      title: 'structure-fire',
      contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
    });

    expect(sendPush).toHaveBeenCalledWith(
      {
        token: 'tok-1',
        alertKind: 'dispatch',
        dispatchId: 'dispatch-1',
        toneSequence: 2,
        title: 'structure-fire',
        body: 'structure-fire — 12 Main St',
        idempotencyKey: 'dispatch-1#2#mbr-1#PUSH',
        collapseKey: 'dispatch-1#2',
      },
      'APNS',
      baseParams.env,
      { isTest: false },
    );
  });

  it('sends an Android (FCM) token via FCM', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      contactChannels: [{ channel: 'PUSH', platform: 'FCM', token: 'fcm-tok', valid: true }],
    });

    expect(sendPush.mock.calls[0]?.[1]).toBe('FCM');
  });

  it('sends the officer mutual-aid prompt as its own notification, with no toneSequence', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      deptId,
      dispatchId: 'dispatch-1',
      memberId: 'officer-1',
      channel: 'push',
      alertKind: 'mutual_aid_prompt',
      title: 'MUTUAL AID REQUESTED',
      contactChannels: [{ channel: 'PUSH', token: 'tok-o', valid: true }],
      message: 'MUTUAL AID REQUESTED — structure-fire — 12 Main St',
      env: {},
    });

    expect(sendPush.mock.calls[0]?.[0]).toMatchObject({
      alertKind: 'mutual_aid_prompt',
      toneSequence: undefined,
      idempotencyKey: 'dispatch-1#MUTUALAID#officer-1#PUSH#SEND',
      collapseKey: 'dispatch-1#MUTUALAID',
    });
  });

  it('SMS stays on the generic vendor adapter and never touches APNs/FCM', async () => {
    const sendPush = vi.fn();
    const sendViaHttpProvider = vi.fn().mockResolvedValue(undefined);
    mockPush(sendPush, sendViaHttpProvider);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...baseParams,
      channel: 'sms',
      contactChannels: [{ channel: 'sms', token: '+12035550100' }],
    });

    expect(sendPush).not.toHaveBeenCalled();
    expect(sendViaHttpProvider).toHaveBeenCalledWith(
      'sms',
      '+12035550100',
      baseParams.message,
      baseParams.env,
      { isTest: false },
    );
  });

  it('a dead token is terminal: guard recorded FAILED, the contact entry marked invalid, nothing thrown (no redelivery)', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'APNS_BadDeviceToken' });
    mockPush(sendPush);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = tableWithSnapshot({
      channel: 'PUSH',
      platform: 'APNS',
      token: 'tok-1',
      valid: true,
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).resolves.toBeUndefined();

    const updates = commandsNamed(send, 'UpdateCommand');
    const guardFailure = updates.find(
      (command) => (command.input.Key as { sk: string }).sk === 'RECEIPT#mbr-1#PUSH#1',
    );
    expect(guardFailure?.input.ExpressionAttributeValues).toEqual({
      ':reason': 'PUSH_TOKEN_INVALID APNS_BadDeviceToken',
      ':failed': 'FAILED',
      ':completedAtMs': expect.any(Number) as number,
      ':deviceSends': { 'token-65dcf16ea3dfa490': 'INVALID' },
    });
    // Never marked SENT.
    expect(
      updates.some(
        (command) =>
          (command.input.ExpressionAttributeValues as Record<string, unknown>)[':sent'] === 'SENT',
      ),
    ).toBe(false);
    const invalidation = updates.find(
      (command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1',
    );
    expect(invalidation?.input.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-1' });
    expect(
      (invalidation?.input.ExpressionAttributeValues as Record<string, unknown>)[
        ':contactChannels'
      ],
    ).toEqual([
      { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: false },
      { channel: 'sms', token: '+12035550100' },
    ]);
    expect(logSpy.mock.calls.some(([line]) => String(line).includes('"TokenInvalid"'))).toBe(true);
    logSpy.mockRestore();
  });

  it('a self-test that hits a token rejection never invalidates the member’s real token', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'APNS_BadDeviceToken' });
    mockPush(sendPush);
    const send = tableWithSnapshot({ channel: 'PUSH', token: 'tok-1', valid: true });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await deliverChannelMessage(fakeDdb(send), 'alerting-table', { ...baseParams, isTest: true });

    // Review round 2 N2: a self-test's rejection must not feed the paging TokenInvalid alarm.
    const metricNames = logSpy.mock.calls.flatMap(([line]) => {
      try {
        const parsed = JSON.parse(String(line)) as {
          _aws?: { CloudWatchMetrics: { Metrics: { Name: string }[] }[] };
        };
        return parsed._aws?.CloudWatchMetrics.flatMap((m) => m.Metrics.map((x) => x.Name)) ?? [];
      } catch {
        return [];
      }
    });
    expect(metricNames).toContain('TestTokenInvalid');
    expect(metricNames).not.toContain('TokenInvalid');
    logSpy.mockRestore();

    expect(sendPush.mock.calls[0]?.[3]).toEqual({ isTest: true });
    const touchedSnapshot = [
      ...commandsNamed(send, 'UpdateCommand'),
      ...commandsNamed(send, 'GetCommand'),
    ].some((command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1');
    expect(touchedSnapshot).toBe(false);
  });

  it('does not invalidate a token the member has since replaced', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' });
    mockPush(sendPush);
    const send = tableWithSnapshot({ channel: 'PUSH', token: 'tok-new', valid: true });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(
      commandsNamed(send, 'UpdateCommand').some(
        (command) => (command.input.Key as { sk: string }).sk === 'MEMBER#mbr-1',
      ),
    ).toBe(false);
  });

  it('a retryable provider error (429/5xx/timeout) is recorded FAILED and rethrown so SQS redelivers', async () => {
    const sendPush = vi.fn().mockRejectedValue(new Error('APNs responded 503 ServiceUnavailable'));
    mockPush(sendPush);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('APNs responded 503');
    expect(commandsNamed(send, 'UpdateCommand')[0]?.input.ExpressionAttributeValues).toEqual({
      ':reason': 'APNs responded 503 ServiceUnavailable',
      ':failed': 'FAILED',
      ':completedAtMs': expect.any(Number) as number,
      ':deviceSends': {},
    });
    errorSpy.mockRestore();
  });

  // Design review C3: the self-test/canary result is this guard. A sandbox provider error is
  // that run's FAIL; redelivering it would only dead-letter a synthetic page and page on-call.
  it('a self-test provider error is recorded FAILED with its completion time and not rethrown', async () => {
    const sendPush = vi.fn().mockRejectedValue(new Error('sandbox endpoint unreachable'));
    mockPush(sendPush);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', { ...baseParams, isTest: true }),
    ).resolves.toBeUndefined();
    expect(commandsNamed(send, 'UpdateCommand')[0]?.input.ExpressionAttributeValues).toEqual({
      ':reason': 'sandbox endpoint unreachable',
      ':failed': 'FAILED',
      ':completedAtMs': expect.any(Number) as number,
      ':deviceSends': {},
    });
    const metrics = logSpy.mock.calls.map(([line]) => String(line));
    expect(metrics.some((line) => line.includes('"TestSendFailed"'))).toBe(true);
    expect(metrics.some((line) => line.includes('"SendFailed"'))).toBe(false);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('deliverChannelMessage — mass token invalidation guard (review M3, round 2 N4)', () => {
  function mockDeadToken(): void {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'invalid_token', reason: 'APNS_BadDeviceToken' });
    vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider: vi.fn() }));
    vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
      sendPush,
    }));
  }

  type Command = { constructor: { name: string }; input: Record<string, unknown> };
  const skOf = (command: Command) => (command.input.Key as { sk?: string } | undefined)?.sk ?? '';
  const snapshot = {
    Item: {
      snapshotUpdatedAt: 1,
      contactChannels: [{ channel: 'PUSH', token: 'tok-1', valid: true }],
    },
  };
  const snapshotWrites = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.filter(
      ([command]) =>
        (command as Command).constructor.name === 'UpdateCommand' &&
        skOf(command as Command) === 'MEMBER#mbr-1',
    );

  it('when the guard trips, the token is NOT invalidated, the latch is written and the send throws', async () => {
    mockDeadToken();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockImplementation((command: Command) => {
      if (command.constructor.name === 'GetCommand' && skOf(command) === 'MEMBER#mbr-1') {
        return Promise.resolve(snapshot);
      }
      if (command.constructor.name === 'UpdateCommand' && skOf(command).startsWith('WINDOW#')) {
        return Promise.resolve({ Attributes: { tokenHashes: new Set(['a', 'b', 'c', 'd']) } });
      }
      return Promise.resolve({});
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('push token invalidation refused');

    expect(snapshotWrites(send)).toHaveLength(0);
    const latchPut = send.mock.calls
      .map(([command]) => command as Command)
      .find(
        (command) =>
          command.constructor.name === 'PutCommand' &&
          (command.input.Item as { sk: string }).sk === 'TRIPPED',
      );
    expect(latchPut).toBeDefined();
    errorSpy.mockRestore();
  });

  it('while the latch holds, every invalidation is refused before counting', async () => {
    mockDeadToken();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockImplementation((command: Command) => {
      if (command.constructor.name === 'GetCommand' && skOf(command) === 'MEMBER#mbr-1') {
        return Promise.resolve(snapshot);
      }
      if (command.constructor.name === 'GetCommand' && skOf(command) === 'TRIPPED') {
        return Promise.resolve({ Item: { ttl: Math.floor(Date.now() / 1000) + 600 } });
      }
      return Promise.resolve({});
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).rejects.toThrow('guard is tripped');
    expect(snapshotWrites(send)).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('a rejection of a token the member has since replaced never reaches the guard (review round 2 m4)', async () => {
    mockDeadToken();
    const send = vi.fn().mockImplementation((command: Command) => {
      if (command.constructor.name === 'GetCommand' && skOf(command) === 'MEMBER#mbr-1') {
        return Promise.resolve({
          Item: { contactChannels: [{ channel: 'PUSH', token: 'tok-new', valid: true }] },
        });
      }
      return Promise.resolve({});
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams);

    expect(
      send.mock.calls.some(([command]) => skOf(command as Command).startsWith('WINDOW#')),
    ).toBe(false);
  });

  it('when the guard itself cannot reach DynamoDB, the token is kept and nothing is thrown (review round 2 m5)', async () => {
    mockDeadToken();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn().mockImplementation((command: Command) => {
      if (command.constructor.name === 'GetCommand' && skOf(command) === 'MEMBER#mbr-1') {
        return Promise.resolve(snapshot);
      }
      if (skOf(command) === 'TRIPPED') {
        return Promise.reject(new Error('ProvisionedThroughputExceeded'));
      }
      return Promise.resolve({});
    });
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', baseParams),
    ).resolves.toBeUndefined();

    expect(snapshotWrites(send)).toHaveLength(0);
    expect(errorSpy.mock.calls.some(([line]) => String(line).includes('invalidate_failed'))).toBe(
      true,
    );
    errorSpy.mockRestore();
  });
});

describe('deliverChannelMessage — self-test configuration refusal (review M5)', () => {
  it('records the guard FAILED, does not throw, and never touches the member snapshot', async () => {
    const sendPush = vi
      .fn()
      .mockResolvedValue({ outcome: 'test_refused', reason: 'FCM_SENDER_ID_MISMATCH' });
    vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider: vi.fn() }));
    vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
      sendPush,
    }));
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', { ...baseParams, isTest: true }),
    ).resolves.toBeUndefined();

    const inputs = send.mock.calls.map(
      (call) => (call[0] as { input: Record<string, unknown> }).input,
    );
    expect(inputs.at(-1)?.ExpressionAttributeValues).toEqual({
      ':reason': 'PUSH_TEST_REFUSED FCM_SENDER_ID_MISMATCH',
      ':failed': 'FAILED',
      ':completedAtMs': expect.any(Number) as number,
      ':deviceSends': { 'token-65dcf16ea3dfa490': 'REFUSED' },
    });
    expect(
      inputs.some((input) => (input.Key as { sk?: string } | undefined)?.sk === 'MEMBER#mbr-1'),
    ).toBe(false);
  });
});

// Multi-device push: the exactly-once key stays per member per channel per tone (one publish,
// one guard); the worker sends to every valid device under it and keeps per-device outcomes.
describe('deliverChannelMessage — multi-device push', () => {
  const PHONE = {
    channel: 'PUSH',
    platform: 'APNS',
    token: 'a'.repeat(64),
    deviceId: 'phone',
    valid: true,
  };
  const TABLET = {
    channel: 'PUSH',
    platform: 'FCM',
    token: 'tok-tablet',
    deviceId: 'tablet',
    valid: true,
  };
  const params: DeliverChannelMessageParams = { ...baseParams, contactChannels: [PHONE, TABLET] };

  function mockPush(sendPush: ReturnType<typeof vi.fn>): void {
    vi.doMock('./httpProviderAdapter.js', () => ({ sendViaHttpProvider: vi.fn() }));
    vi.doMock('./push/pushProviderAdapter.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./push/pushProviderAdapter.js')>()),
      sendPush,
    }));
  }

  function updates(send: ReturnType<typeof vi.fn>) {
    return send.mock.calls
      .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((command) => command.constructor.name === 'UpdateCommand')
      .map((command) => command.input);
  }

  it('pages every registered device under the one per-channel guard and idempotency key', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', params);

    expect(sendPush).toHaveBeenCalledTimes(2);
    expect(
      sendPush.mock.calls.map(([n, platform]) => [
        (n as { token: string }).token,
        platform as string,
      ]),
    ).toEqual([
      [PHONE.token, 'APNS'],
      ['tok-tablet', 'FCM'],
    ]);
    for (const [notification] of sendPush.mock.calls) {
      expect((notification as { idempotencyKey: string }).idempotencyKey).toBe(
        'dispatch-1#1#mbr-1#PUSH',
      );
    }
    const puts = send.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'PutCommand',
    );
    expect(puts).toHaveLength(1);
    expect(updates(send)[0]?.ExpressionAttributeValues).toMatchObject({
      ':sent': 'SENT',
      ':deviceSends': { phone: 'SENT', tablet: 'SENT' },
    });
  });

  // Review MAJOR-2: each iOS device is sent on its own build's APNs environment, for a real
  // page and a labelled self-test alike.
  it('sends each device on its registered APNs environment, and labels a self-test', async () => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
      ...params,
      isTest: true,
      contactChannels: [{ ...PHONE, apnsEnvironment: 'development' }, TABLET],
    });

    const calls = sendPush.mock.calls as [{ isTest?: boolean }, string, unknown, object][];
    expect(calls.map(([n, , , options]) => [n.isTest, options])).toEqual([
      [true, { isTest: true, apnsEnvironment: 'development' }],
      [true, { isTest: true }],
    ]);
  });

  // Review round 2 item b: an FCM test send that only validated is VALIDATED, never SENT.
  it.each([
    ['a self-test (deliver)', 'deliver', 'SENT', { isTest: true, fcmDeliver: true }],
    ['the canary (validate)', 'validate', 'VALIDATED', { isTest: true }],
  ] as const)('%s on Android is recorded %s', async (_label, testDelivery, state, options) => {
    const sendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(sendPush);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await deliverChannelMessage(fakeDdb(send), 'alerting-table', {
      ...params,
      isTest: true,
      testDelivery,
      contactChannels: [TABLET],
    });

    expect(sendPush.mock.calls[0]?.[3]).toEqual(options);
    expect(updates(send).at(-1)?.ExpressionAttributeValues).toMatchObject({
      ':sent': 'SENT',
      ':deviceSends': { tablet: state },
    });
  });

  // Review R2-m1: a development-registered device needs the sandbox APNs secret; a missing one
  // still fails the page (redelivered, dead-lettered) but is named and counted - alarmed.
  it('a missing push secret fails the page and is counted as PushCredentialsUnavailable', async () => {
    const { PushCredentialsUnavailableError } = await import('./push/pushCredentials.js');
    const sendPush = vi
      .fn()
      .mockRejectedValue(
        new PushCredentialsUnavailableError(
          'APNS_SANDBOX_SECRET_ID is required and was not set',
          'APNS_SANDBOX_SECRET_ID',
        ),
      );
    mockPush(sendPush);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(vi.fn().mockResolvedValue({})), 'alerting-table', {
        ...params,
        contactChannels: [{ ...PHONE, apnsEnvironment: 'development' }],
      }),
    ).rejects.toThrow('APNS_SANDBOX_SECRET_ID');
    expect(
      logSpy.mock.calls.some(([line]) => String(line).includes('"PushCredentialsUnavailable"')),
    ).toBe(true);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('one device accepted, one transiently failed: FAILED and rethrown, and the redelivery sends only to the failed device', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendPush = vi
      .fn()
      .mockImplementation((n: { token: string }) =>
        n.token === 'tok-tablet'
          ? Promise.reject(new Error('FCM 503'))
          : Promise.resolve({ outcome: 'sent' }),
      );
    mockPush(sendPush);
    const send = vi.fn().mockResolvedValue({});
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(deliverChannelMessage(fakeDdb(send), 'alerting-table', params)).rejects.toThrow(
      'FCM 503',
    );
    expect(updates(send)[0]?.ExpressionAttributeValues).toMatchObject({
      ':failed': 'FAILED',
      ':deviceSends': { phone: 'SENT' },
    });

    // Redelivery: the claim collides, the recorded failure is re-claimed, and the phone that
    // already rang is skipped.
    vi.resetModules();
    const redeliverySendPush = vi.fn().mockResolvedValue({ outcome: 'sent' });
    mockPush(redeliverySendPush);
    const redelivery = vi.fn((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'PutCommand') {
        return Promise.reject(
          new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
        );
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({
          Item: {
            deliveredAt: null,
            failureReason: 'FCM 503',
            sendState: 'FAILED',
            sentAt: 1,
            deviceSends: { phone: 'SENT' },
          },
        });
      }
      return Promise.resolve({});
    });
    const again = await import('./deliverChannelMessage.js');
    await again.deliverChannelMessage(fakeDdb(redelivery), 'alerting-table', params);

    expect(redeliverySendPush).toHaveBeenCalledTimes(1);
    expect((redeliverySendPush.mock.calls[0]![0] as { token: string }).token).toBe('tok-tablet');
    expect(updates(redelivery).at(-1)?.ExpressionAttributeValues).toMatchObject({
      ':sent': 'SENT',
      ':deviceSends': { phone: 'SENT', tablet: 'SENT' },
    });
    errorSpy.mockRestore();
  });

  it('a dead tablet token does not fail the page the phone received, and only the dead token is invalidated', async () => {
    const sendPush = vi
      .fn()
      .mockImplementation((n: { token: string }) =>
        Promise.resolve(
          n.token === 'tok-tablet'
            ? { outcome: 'invalid_token', reason: 'FCM_UNREGISTERED' }
            : { outcome: 'sent' },
        ),
      );
    mockPush(sendPush);
    const send = vi.fn(
      (command: { constructor: { name: string }; input: { Key?: { sk?: string } } }) =>
        Promise.resolve(
          command.constructor.name === 'GetCommand' && command.input.Key?.sk === 'MEMBER#mbr-1'
            ? { Item: { contactVersion: 1, contactChannels: [PHONE, TABLET] } }
            : {},
        ),
    );
    const { deliverChannelMessage } = await import('./deliverChannelMessage.js');

    await expect(
      deliverChannelMessage(fakeDdb(send), 'alerting-table', params),
    ).resolves.toBeUndefined();

    const all = updates(send);
    const invalidation = all.find((input) => (input.Key as { sk: string }).sk === 'MEMBER#mbr-1');
    expect(invalidation?.ExpressionAttributeValues).toMatchObject({
      ':contactChannels': [PHONE, { ...TABLET, valid: false }],
    });
    expect(all.at(-1)?.ExpressionAttributeValues).toMatchObject({
      ':sent': 'SENT',
      ':deviceSends': { phone: 'SENT', tablet: 'INVALID' },
    });
  });
});
