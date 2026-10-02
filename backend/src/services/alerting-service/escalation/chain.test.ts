import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';

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
  const setClause = updateExpression.replace(/^SET /, '').split(' REMOVE ')[0] ?? '';
  for (const assignment of setClause.split(/,(?![^(]*\))/)) {
    const [field, valueRef] = assignment.split('=').map((part) => part.trim());
    if (!field || !valueRef) {
      continue;
    }
    const ifNotExists = /^if_not_exists\([^,]+,\s*(:\w+)\)$/.exec(valueRef);
    if (ifNotExists) {
      existing[field] ??= values[ifNotExists[1]!];
    } else if (valueRef in values) {
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
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(idempotencyKey)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        const error = new Error('conditional check failed');
        error.name = 'TransactionCanceledException';
        (error as unknown as { CancellationReasons: { Code: string }[] }).CancellationReasons =
          transactItems.map((_, i) => ({
            Code: i === failedIndex ? 'ConditionalCheckFailed' : 'None',
          }));
        throw error;
      }
      for (const txItem of transactItems) {
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
      return Promise.resolve({});
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const mapKey = `${put.Item.pk}#${put.Item.sk}`;
      if (put.ConditionExpression?.startsWith('attribute_not_exists') && items.has(mapKey)) {
        const error = new Error('conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        return Promise.reject(error);
      }
      items.set(mapKey, put.Item);
      return Promise.resolve({});
    }
    if (name === 'UpdateCommand') {
      const update = input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      applyUpdate(items, update.Key, update.UpdateExpression, update.ExpressionAttributeValues);
      return Promise.resolve({});
    }
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'QueryCommand') {
      const query = input as { ExpressionAttributeValues: Record<string, string> };
      return Promise.resolve({
        Items: [...items.values()].filter(
          (item) => item.pk === query.ExpressionAttributeValues[':pk'],
        ),
      });
    }
    throw new Error(`escalation/chain.test.ts fake ddb: unsupported command ${name}`);
  });
  return { send: send, items };
}

function dispatchAlertInsert(dispatchId: string): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-1',
        dynamodb: {
          SequenceNumber: '1',
          NewImage: {
            pk: { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: dispatchId },
            deptId: { S: 'NICHOLS' },
            sourceSystem: { S: 'MANUAL' },
            incidentType: { S: 'STRUCTURE_FIRE' },
            address: { S: '123 Main St' },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

function eligibleMember(memberId: string): FakeItem {
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: `MEMBER#${memberId}`,
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId,
    active: true,
    quals: [],
    roles: [],
    availabilityState: 'AVAILABLE',
    contactChannels: [
      { channel: 'PUSH', platform: 'APNS', token: `tok-${memberId}`, valid: true },
      { channel: 'SMS', phoneNumber: '+12035550100', valid: true },
    ],
    snapshotUpdatedAt: 0,
  };
}

describe('E1-S3 chain: fan-out -> schedule -> escalation-fired handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:alerting-topic.fifo';
    process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('escalates a non-acking member exactly once and leaves an acked member alone (AC1/AC2/AC3/AC5)', async () => {
    const alerting = createFakeDdb([eligibleMember('mbr-1'), eligibleMember('mbr-2')]);

    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return {
        ...actual,
        createDynamoClient: () => ({ send: alerting.send }) as unknown as DynamoDBDocumentClient,
      };
    });

    const schedulerSend = vi.fn().mockResolvedValue({});
    vi.doMock('./scheduleEscalation.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./scheduleEscalation.js')>()),
      getSchedulerClient: () => ({ send: schedulerSend }),
    }));
    const fanOutSnsSend = vi.fn().mockResolvedValue({});
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
      createSnsClient: () => ({ send: fanOutSnsSend }) as unknown as SNSClient,
    }));
    const snsSend = vi.fn().mockResolvedValue({});
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return {
        ...actual,
        getSnsClient: () => ({ send: snsSend }) as unknown as SNSClient,
      };
    });

    const { handler: fanOutHandler } = await import('../fanout/handler.js');
    const { handler: escalationHandler } = await import('./escalationHandler.js');

    // The stream fan-out is the single tone-1 producer (design review C1): it publishes and
    // writes the receipts, roster rows, per-member escalation and the tone ladder.
    expect(await fanOutHandler(dispatchAlertInsert('dispatch-1'))).toEqual({
      batchItemFailures: [],
    });

    expect(fanOutSnsSend).toHaveBeenCalledTimes(4);
    // Two per-member escalations plus the tone-2 and tone-3 evaluator schedules.
    expect(schedulerSend).toHaveBeenCalledTimes(4);
    const pushBefore = alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#push#1');
    const smsBefore = alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#sms#1');
    expect(pushBefore).toBeDefined();
    expect(smsBefore).toBeDefined();

    alerting.items.set('DEPT#NICHOLS#DISPATCH#dispatch-1#ROSTER#mbr-2', {
      ...alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#ROSTER#mbr-2')!,
      ackStatus: 'RESPONDING',
    });

    const escalatedResult = await escalationHandler({
      deptId: 'NICHOLS',
      dispatchId: 'dispatch-1',
      memberId: 'mbr-1',
      toneSequence: 1,
      channel: 'voice',
    });
    const ackedResult = await escalationHandler({
      deptId: 'NICHOLS',
      dispatchId: 'dispatch-1',
      memberId: 'mbr-2',
      toneSequence: 1,
      channel: 'voice',
    });

    expect(escalatedResult).toEqual({ outcome: 'ESCALATED' });
    expect(ackedResult).toEqual({ outcome: 'SKIPPED_ACKED' });

    expect(alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#push#1')).toEqual(
      pushBefore,
    );
    expect(alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#sms#1')).toEqual(
      smsBefore,
    );
    expect(
      alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-1#voice#1'),
    ).toBeDefined();
    expect(alerting.items.has('DEPT#NICHOLS#DISPATCH#dispatch-1#RECEIPT#mbr-2#voice#1')).toBe(
      false,
    );

    expect(snsSend).toHaveBeenCalledTimes(1);
  });

  // Review MAJOR-1: the pages go out before the fan-out seeds roster rows, so a fast lock-screen
  // answer can create the row first. It must still carry what the escalation handler needs.
  it('an answer recorded before the fan-out seeds the roster is kept, and the 75 s escalation skips it as acked', async () => {
    const alerting = createFakeDdb([
      eligibleMember('mbr-1'),
      {
        pk: 'DEPT#NICHOLS#DISPATCH#dispatch-2',
        sk: 'METADATA',
        entityType: 'DISPATCH_ALERT',
        dispatchId: 'dispatch-2',
        deptId: 'NICHOLS',
        currentToneSequence: 1,
        isTest: false,
      },
    ]);
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => ({ send: alerting.send }) as unknown as DynamoDBDocumentClient,
    }));
    vi.doMock('./scheduleEscalation.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./scheduleEscalation.js')>()),
      getSchedulerClient: () => ({ send: vi.fn().mockResolvedValue({}) }),
    }));
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
      createSnsClient: () => ({ send: vi.fn().mockResolvedValue({}) }) as unknown as SNSClient,
    }));
    const snsSend = vi.fn().mockResolvedValue({});
    vi.doMock('./snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./snsClient.js')>()),
      getSnsClient: () => ({ send: snsSend }) as unknown as SNSClient,
    }));

    const { recordResponse } = await import('../responses/repository.js');
    const { toVerifiedDeptId } = await import('@boxalarm/dept-scope');
    const answered = await recordResponse(
      { send: alerting.send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      {
        deptId: toVerifiedDeptId({ deptId: 'NICHOLS' }),
        dispatchId: 'dispatch-2',
        memberId: 'mbr-1',
        ackStatus: 'RESPONDING',
        eta: null,
        assignedApparatusId: null,
        answeredAt: 1798000001,
      },
    );
    expect(answered).toMatchObject({ outcome: 'recorded', roster: 'APPLIED' });

    const { handler: fanOutHandler } = await import('../fanout/handler.js');
    expect(await fanOutHandler(dispatchAlertInsert('dispatch-2'))).toEqual({
      batchItemFailures: [],
    });
    expect(alerting.items.get('DEPT#NICHOLS#DISPATCH#dispatch-2#ROSTER#mbr-1')).toMatchObject({
      ackStatus: 'RESPONDING',
      currentChannelTier: 'primary',
      escalationLevel: 0,
    });

    const { handler: escalationHandler } = await import('./escalationHandler.js');
    await expect(
      escalationHandler({
        deptId: 'NICHOLS',
        dispatchId: 'dispatch-2',
        memberId: 'mbr-1',
        toneSequence: 1,
        channel: 'voice',
      }),
    ).resolves.toEqual({ outcome: 'SKIPPED_ACKED' });
    expect(snsSend).not.toHaveBeenCalled();
  });
});
