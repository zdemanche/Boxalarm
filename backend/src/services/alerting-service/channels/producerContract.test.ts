/**
 * Producer -> consumer contract for the alerting SNS FIFO topic.
 *
 * The SNS->SQS subscriptions use rawMessageDelivery, so each channel worker's SQS body is
 * byte-for-byte the `Message` a producer published. These tests drive every real producer
 * against in-memory fakes, capture the exact PublishCommand it sends, and feed that Message
 * string through the consumer's parser for the channel the subscription filter would route
 * it to. Worker unit tests build their own fixtures; this file is what binds a producer to
 * the parser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { parseChannelEnvelope, type ChannelName } from './channelEnvelope.js';

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

interface PublishInput {
  readonly TopicArn: string;
  readonly Message: string;
  readonly MessageGroupId: string;
  readonly MessageDeduplicationId: string;
  readonly MessageAttributes: Record<string, { DataType: string; StringValue: string }>;
}

const TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
const DISPATCH_ID = 'NICHOLS-MANUAL-1798000000-abcd1234';
const DISPATCH_PK = `DEPT#NICHOLS#DISPATCH#${DISPATCH_ID}`;

function conditionFailed(name: string): Error {
  const error = new Error('conditional check failed');
  error.name = name;
  return error;
}

/** Minimal single-table fake: enough for every producer's reads and guarded writes. */
function createFakeDdb(seed: readonly FakeItem[]): {
  client: DynamoDBDocumentClient;
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  const keyOf = (key: { pk: string; sk: string }): string => `${key.pk}#${key.sk}`;
  for (const item of seed) {
    items.set(keyOf(item), item);
  }
  const conditionHolds = (item: FakeItem, condition: string | undefined): boolean =>
    !condition?.startsWith('attribute_not_exists') || !items.has(keyOf(item));
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    switch (name) {
      case 'GetCommand': {
        const key = input.Key as { pk: string; sk: string };
        return Promise.resolve({ Item: items.get(keyOf(key)) });
      }
      case 'QueryCommand': {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        const prefix = values[':skPrefix'] ?? values[':prefix'] ?? '';
        return Promise.resolve({
          Items: [...items.values()].filter(
            (item) => item.pk === values[':pk'] && item.sk.startsWith(prefix),
          ),
        });
      }
      case 'PutCommand': {
        const put = input as { Item: FakeItem; ConditionExpression?: string };
        if (!conditionHolds(put.Item, put.ConditionExpression)) {
          return Promise.reject(conditionFailed('ConditionalCheckFailedException'));
        }
        items.set(keyOf(put.Item), put.Item);
        return Promise.resolve({});
      }
      case 'UpdateCommand':
        return Promise.resolve({});
      case 'TransactWriteCommand': {
        const txItems = input.TransactItems as ReadonlyArray<{
          Put?: { Item: FakeItem; ConditionExpression?: string };
        }>;
        const reasons = txItems.map((txItem) =>
          txItem.Put && !conditionHolds(txItem.Put.Item, txItem.Put.ConditionExpression)
            ? { Code: 'ConditionalCheckFailed' }
            : { Code: 'None' },
        );
        if (reasons.some((reason) => reason.Code !== 'None')) {
          return Promise.reject(
            Object.assign(conditionFailed('TransactionCanceledException'), {
              CancellationReasons: reasons,
            }),
          );
        }
        for (const txItem of txItems) {
          if (txItem.Put) {
            items.set(keyOf(txItem.Put.Item), txItem.Put.Item);
          }
        }
        return Promise.resolve({});
      }
      default:
        return Promise.reject(new Error(`producerContract fake ddb: unsupported ${name}`));
    }
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, items };
}

function createFakeSns(): { client: SNSClient; published: PublishInput[] } {
  const published: PublishInput[] = [];
  const send = vi.fn((command: unknown) => {
    published.push((command as { input: PublishInput }).input);
    return Promise.resolve({ MessageId: `msg-${published.length}` });
  });
  return { client: { send } as unknown as SNSClient, published };
}

/** The SNS subscription filter policy is `{ channel: [channel] }` on the message attribute. */
function routedChannel(publish: PublishInput): ChannelName {
  const channel = publish.MessageAttributes.channel?.StringValue;
  if (channel !== 'push' && channel !== 'sms' && channel !== 'voice') {
    throw new Error(`publish carries no routable channel attribute: ${String(channel)}`);
  }
  return channel;
}

function memberSnapshot(memberId: string, roles: readonly string[] = []): FakeItem {
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: `MEMBER#${memberId}`,
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId,
    active: true,
    quals: [],
    roles: [...roles],
    // Both SMS shapes on purpose: the producers' resolveSmsTarget reads {channel:'sms', token}
    // while the worker's resolveChannelTarget reads {channel:'SMS', phoneNumber}. That target
    // shape split is a separate, known defect; this file pins the envelope contract only.
    contactChannels: [
      { channel: 'PUSH', token: `tok-${memberId}`, platform: 'APNS', valid: true },
      { channel: 'sms', token: '+15551234567', valid: true },
      { channel: 'SMS', phoneNumber: '+15551234567', valid: true },
    ],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: 1000,
  };
}

const METADATA_ITEM: FakeItem = {
  pk: DISPATCH_PK,
  sk: 'METADATA',
  entityType: 'DISPATCH_ALERT',
  dispatchId: DISPATCH_ID,
  deptId: 'NICHOLS',
  sourceSystem: 'MANUAL',
  incidentType: 'STRUCTURE_FIRE',
  address: '123 Main St',
  crossStreets: 'Main & Elm',
  narrative: 'Smoke showing',
  isTest: false,
  toneLadderStatus: 'ACTIVE',
  currentToneSequence: 1,
};

function unackedRosterEntry(memberId: string): FakeItem {
  return {
    pk: DISPATCH_PK,
    sk: `ROSTER#${memberId}`,
    entityType: 'DISPATCH_ROSTER_ENTRY',
    memberId,
    ackStatus: 'NONE',
    currentChannelTier: 'primary',
  };
}

function dispatchAlertInsertEvent(): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-1',
        dynamodb: {
          SequenceNumber: 'seq-1',
          NewImage: {
            pk: { S: DISPATCH_PK },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: DISPATCH_ID },
            deptId: { S: 'NICHOLS' },
            sourceSystem: { S: 'MANUAL' },
            incidentType: { S: 'STRUCTURE_FIRE' },
            address: { S: '123 Main St' },
            isTest: { BOOL: false },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

function mockAwsClients(ddb: DynamoDBDocumentClient, sns: SNSClient): void {
  vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
    createDynamoClient: () => ddb,
  }));
  vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
    createSnsClient: () => sns,
  }));
  vi.doMock('../escalation/snsClient.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../escalation/snsClient.js')>()),
    getSnsClient: () => sns,
  }));
  vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../escalation/scheduleEscalation.js')>()),
    getSchedulerClient: () => ({ send: vi.fn().mockResolvedValue({}) }),
    createEscalationSchedule: vi.fn().mockResolvedValue('schedule-name'),
  }));
  vi.doMock('../fanout/fanOut.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../fanout/fanOut.js')>()),
    scheduleRealtimeFanOutEscalation: vi.fn().mockResolvedValue(undefined),
  }));
}

describe('alerting topic producer -> channel worker contract', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
    process.env.ALERTING_TOPIC_ARN = TOPIC_ARN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../eligibility/dynamoClient.js');
    vi.doUnmock('../fanout/snsClient.js');
    vi.doUnmock('../escalation/snsClient.js');
    vi.doUnmock('../escalation/scheduleEscalation.js');
    vi.doUnmock('../fanout/fanOut.js');
    vi.restoreAllMocks();
  });

  it('fan-out (tone 1, push + sms): every published Message parses for its routed channel', async () => {
    const ddb = createFakeDdb([memberSnapshot('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../fanout/handler.js');

    const result = await handler(dispatchAlertInsertEvent());

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sns.published.map(routedChannel).sort()).toEqual(['push', 'sms']);
    for (const publish of sns.published) {
      const channel = routedChannel(publish);
      expect(parseChannelEnvelope(publish.Message, channel)).toEqual({
        deptId: 'NICHOLS',
        dispatchId: DISPATCH_ID,
        memberId: 'mbr-1',
        channel,
        toneSequence: 1,
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
      });
      const payload = (JSON.parse(publish.Message) as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({ isTest: false, channelTier: 'primary' });
      expect(publish.MessageGroupId).toBe(DISPATCH_ID);
    }
  });

  it('fan-out still emits a parseable page when the dispatch record lacks incidentType/address', async () => {
    const ddb = createFakeDdb([memberSnapshot('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../fanout/handler.js');
    const event = dispatchAlertInsertEvent();
    const image = event.Records[0]!.dynamodb!.NewImage as Record<string, unknown>;
    delete image.incidentType;
    delete image.address;

    await handler(event);

    expect(sns.published.length).toBeGreaterThan(0);
    for (const publish of sns.published) {
      const parsed = parseChannelEnvelope(publish.Message, routedChannel(publish));
      expect(parsed.incidentType).toBe('DISPATCH');
      expect(parsed.address).toBe('ADDRESS UNAVAILABLE - CHECK CAD/RADIO');
    }
  });

  it('tone evaluator (tone 2, push + sms): every published Message parses for its routed channel', async () => {
    const ddb = createFakeDdb([METADATA_ITEM, memberSnapshot('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../escalation/toneEvaluatorHandler.js');

    const result = await handler({ deptId: 'NICHOLS', dispatchId: DISPATCH_ID, toneSequence: 2 });

    expect(result).toEqual({ outcome: 'FIRED' });
    expect(sns.published.map(routedChannel).sort()).toEqual(['push', 'sms']);
    for (const publish of sns.published) {
      const channel = routedChannel(publish);
      expect(parseChannelEnvelope(publish.Message, channel)).toEqual({
        deptId: 'NICHOLS',
        dispatchId: DISPATCH_ID,
        memberId: 'mbr-1',
        channel,
        toneSequence: 2,
        incidentType: 'STRUCTURE_FIRE',
        address: '123 Main St',
      });
      const payload = (JSON.parse(publish.Message) as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({ isTest: false, channelTier: 'escalation' });
    }
  });

  it('voice escalation: the published Message parses for the voice worker with the dispatch text', async () => {
    const ddb = createFakeDdb([{ ...METADATA_ITEM, isTest: true }, unackedRosterEntry('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../escalation/escalationHandler.js');

    const result = await handler({
      deptId: 'NICHOLS',
      dispatchId: DISPATCH_ID,
      memberId: 'mbr-1',
      toneSequence: 2,
      channel: 'voice',
    });

    expect(result).toEqual({ outcome: 'ESCALATED' });
    expect(sns.published).toHaveLength(1);
    const publish = sns.published[0]!;
    expect(routedChannel(publish)).toBe('voice');
    expect(parseChannelEnvelope(publish.Message, 'voice')).toEqual({
      deptId: 'NICHOLS',
      dispatchId: DISPATCH_ID,
      memberId: 'mbr-1',
      channel: 'voice',
      toneSequence: 2,
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
    });
    const payload = (JSON.parse(publish.Message) as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ isTest: true, channelTier: 'escalation' });
    expect(publish.MessageGroupId).toBe(DISPATCH_ID);
  });

  it('voice escalation still pages a parseable Message when the dispatch METADATA item is gone', async () => {
    const ddb = createFakeDdb([unackedRosterEntry('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../escalation/escalationHandler.js');

    await handler({
      deptId: 'NICHOLS',
      dispatchId: DISPATCH_ID,
      memberId: 'mbr-1',
      toneSequence: 1,
      channel: 'voice',
    });

    const parsed = parseChannelEnvelope(sns.published[0]!.Message, 'voice');
    expect(parsed).toMatchObject({ deptId: 'NICHOLS', incidentType: 'DISPATCH' });
    const payload = (JSON.parse(sns.published[0]!.Message) as { payload: Record<string, unknown> })
      .payload;
    expect(payload.isTest).toBe(false);
  });

  it('a published Message with deptId stripped is still rejected by the parser (negative control)', async () => {
    const ddb = createFakeDdb([memberSnapshot('mbr-1')]);
    const sns = createFakeSns();
    mockAwsClients(ddb.client, sns.client);
    const { handler } = await import('../fanout/handler.js');
    await handler(dispatchAlertInsertEvent());
    const publish = sns.published[0]!;
    const envelope = JSON.parse(publish.Message) as { payload: Record<string, unknown> };
    delete envelope.payload.deptId;

    expect(() => parseChannelEnvelope(JSON.stringify(envelope), routedChannel(publish))).toThrow(
      'alerting channel envelope failed shape validation',
    );
  });
});
