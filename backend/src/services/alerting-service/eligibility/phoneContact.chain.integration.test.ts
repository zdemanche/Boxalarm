import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import type { PublishCommandInput, SNSClient } from '@aws-sdk/client-sns';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';

/**
 * Design review C2, producer -> consumer -> worker, against a real DynamoDB (LocalStack):
 *
 *   personnel createMember (outbox row with phone)
 *     -> the deployed platform outbox drain (@boxalarm/outbox) -> EventBridge event
 *     -> the alerting-owned consumer (memberUpdatedHandler) -> SMS/VOICE contact entries
 *     -> the stream fan-out publishes SMS -> the SMS worker sends to the member's phone,
 *        and the voice worker dials it.
 *
 * Before the fix no deployed producer wrote SMS or VOICE entries: the fan-out published SMS
 * for every member and the worker dropped every one as NoTargetRegistered.
 */

const ALERTING_TABLE = 'alerting-table';
const PLATFORM_TABLE = 'platform-table';
const DEPT = 'NICHOLS';
const MEMBER_ID = 'sub-jamie';
const PHONE = '+12035550100';

async function createTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

/** What the EventBridge rule target (no inputPath) delivers into the consumer's SQS queue. */
function sqsBodyFrom(entry: PutEventsRequestEntry): SQSEvent {
  return {
    Records: [
      {
        messageId: `msg-${Math.random()}`,
        body: JSON.stringify({
          version: '0',
          'detail-type': entry.DetailType,
          source: entry.Source,
          detail: JSON.parse(entry.Detail ?? '{}') as unknown,
        }),
      },
    ],
  } as unknown as SQSEvent;
}

describe('C2: member phone -> SMS/VOICE contact entries -> the workers send to it', () => {
  let container: StartedLocalStackContainer;
  let docClient: DynamoDBDocumentClient;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:3').start();
    const lowLevel = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    docClient = DynamoDBDocumentClient.from(lowLevel, {
      marshallOptions: { removeUndefinedValues: true },
    });
    await createTable(lowLevel, ALERTING_TABLE);
    await createTable(lowLevel, PLATFORM_TABLE);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = ALERTING_TABLE;
    process.env.PLATFORM_TABLE_NAME = PLATFORM_TABLE;
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting.fifo';
    process.env.ESCALATION_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:escalation';
    process.env.TONE_EVALUATOR_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:tone-evaluator';
    process.env.ESCALATION_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    process.env.ESCALATION_SCHEDULE_GROUP_NAME = 'boxalarm-dev-alerting-escalation';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  /** Runs the real createMember; its transaction is written to LocalStack's platform table. */
  async function createMemberOutboxRow(): Promise<Record<string, unknown>> {
    const captured: TransactWriteCommand[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound below via .call
    const originalSend = DynamoDBDocumentClient.prototype.send as (c: unknown) => Promise<unknown>;
    const spy = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(function (
      this: DynamoDBDocumentClient,
      command: unknown,
    ) {
      if (this === docClient) {
        return originalSend.call(this, command);
      }
      captured.push(command as TransactWriteCommand);
      return Promise.resolve({});
    } as never);
    const { createMember } = await import('../../personnel-service/lib/memberRepository.js');
    await createMember(
      PLATFORM_TABLE,
      { deptId: DEPT },
      {
        firstName: 'Jamie',
        lastName: 'Rios',
        phone: PHONE,
        email: 'jamie@example.com',
        joinDate: '2026-01-01',
        rank: 'FIREFIGHTER',
        agencyId: 'NFD-0099',
      },
      'admin-1',
      MEMBER_ID,
    );
    spy.mockRestore();
    const outbox = captured[0]?.input.TransactItems?.map((item) => item.Put?.Item).find(
      (item) => item?.entityType === 'OUTBOX_ENTRY',
    );
    expect(outbox).toBeDefined();
    return outbox!;
  }

  /** The deployed drain: stream INSERT of the outbox row -> PutEvents entry. */
  async function drain(outbox: Record<string, unknown>): Promise<PutEventsRequestEntry> {
    const entries: PutEventsRequestEntry[] = [];
    const eventBridgeClient = {
      send: vi.fn((command: { input: { Entries: PutEventsRequestEntry[] } }) => {
        entries.push(...command.input.Entries);
        return Promise.resolve({ Entries: command.input.Entries.map(() => ({ EventId: 'e' })) });
      }),
    } as unknown as EventBridgeClient;
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const handler = createOutboxDrainHandler('platform-service', {
      eventBridgeClient,
      ddbClient: docClient,
    });
    await docClient.send(new PutCommand({ TableName: PLATFORM_TABLE, Item: outbox }));
    const result = await handler(
      {
        Records: [
          {
            eventName: 'INSERT',
            dynamodb: {
              SequenceNumber: '1',
              NewImage: marshall(outbox, { removeUndefinedValues: true }),
            },
          },
        ],
      } as unknown as DynamoDBStreamEvent,
      {} as never,
      () => undefined,
    );
    expect(result).toEqual({ batchItemFailures: [] });
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  function wireAlertingClients(published: PublishCommandInput[]): void {
    vi.doMock('./dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
    vi.doMock('../fanout/snsClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../fanout/snsClient.js')>()),
      createSnsClient: () =>
        ({
          send: vi.fn((command: { input: PublishCommandInput }) => {
            published.push(command.input);
            return Promise.resolve({ MessageId: 'm' });
          }),
        }) as unknown as SNSClient,
    }));
    vi.doMock('../escalation/scheduleEscalation.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../escalation/scheduleEscalation.js')>()),
      getSchedulerClient: () =>
        ({ send: vi.fn().mockResolvedValue({}) }) as unknown as SchedulerClient,
    }));
  }

  it('a created member is paged on SMS at their phone and dialled on voice, and a later push registration keeps both', async () => {
    const published: PublishCommandInput[] = [];
    const providerSends: string[][] = [];
    wireAlertingClients(published);
    vi.doMock('../channels/httpProviderAdapter.js', () => ({
      sendViaHttpProvider: vi.fn((channel: string, target: string) => {
        providerSends.push([channel, target]);
        return Promise.resolve();
      }),
    }));

    // Producer -> transport -> consumer.
    const created = await drain(await createMemberOutboxRow());
    expect(created).toMatchObject({
      Source: 'personnel-service',
      DetailType: 'personnel.member.updated',
    });
    const { handler: consume } = await import('./memberUpdatedHandler.js');
    expect(await consume(sqsBodyFrom(created))).toEqual({ batchItemFailures: [] });

    // A later push-token registration (registerToken's payload shape) must not drop the
    // phone entries, and vice versa.
    const registered: PutEventsRequestEntry = {
      Source: 'personnel-service',
      DetailType: 'personnel.member.updated',
      Detail: JSON.stringify({
        eventId: 'evt-register',
        eventTime: new Date(Date.now() + 1000).toISOString(),
        eventType: 'personnel.member.updated',
        payload: {
          deptId: DEPT,
          memberId: MEMBER_ID,
          contactChannels: [{ channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true }],
        },
      }),
    };
    await consume(sqsBodyFrom(registered));

    const { Item: snapshot } = await docClient.send(
      new GetCommand({
        TableName: ALERTING_TABLE,
        Key: { pk: `DEPT#${DEPT}#ELIGIBILITY`, sk: `MEMBER#${MEMBER_ID}` },
      }),
    );
    expect(snapshot).toMatchObject({
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      active: true,
      availabilityState: 'AVAILABLE',
      roles: ['MEMBER'],
    });
    expect(snapshot?.contactChannels).toEqual([
      { channel: 'PUSH', platform: 'APNS', token: 'tok-1', valid: true },
      { channel: 'SMS', phoneNumber: PHONE, valid: true },
      { channel: 'VOICE', phoneNumber: PHONE, valid: true },
    ]);

    // Fan-out publishes SMS for the member (it checks the SMS target first).
    const dispatchId = `NICHOLS-MANUAL-${Date.now()}-c2c2c2c2`;
    const alert = {
      pk: `DEPT#${DEPT}#DISPATCH#${dispatchId}`,
      sk: 'METADATA',
      entityType: 'DISPATCH_ALERT',
      dispatchId,
      deptId: DEPT,
      sourceSystem: 'MANUAL',
      incidentType: 'STRUCTURE_FIRE',
      address: '123 Main St',
      isTest: false,
    };
    await docClient.send(new PutCommand({ TableName: ALERTING_TABLE, Item: alert }));
    const { handler: fanOut } = await import('../fanout/handler.js');
    expect(
      await fanOut({
        Records: [
          {
            eventName: 'INSERT',
            eventID: 'ev-1',
            dynamodb: { SequenceNumber: '1', NewImage: marshall(alert) },
          },
        ],
      } as unknown as DynamoDBStreamEvent),
    ).toEqual({ batchItemFailures: [] });
    const smsPublish = published.find(
      (input) => input.MessageAttributes?.channel?.StringValue === 'sms',
    );
    expect(smsPublish).toBeDefined();

    // Worker: the SMS page (the exact Message) is sent to the phone; a voice page is dialled.
    const { createChannelWorkerHandler } = await import('../channels/deliverChannelMessage.js');
    const { buildChannelPagePayload } = await import('../channels/channelEnvelope.js');
    const { toVerifiedDeptId } = await import('@boxalarm/dept-scope');
    expect(
      await createChannelWorkerHandler('sms')({
        Records: [{ messageId: 'sms-1', body: smsPublish!.Message! }],
      } as unknown as SQSEvent),
    ).toEqual({ batchItemFailures: [] });
    const voiceBody = JSON.stringify({
      payload: buildChannelPagePayload({
        deptId: toVerifiedDeptId({ deptId: DEPT }),
        dispatchId,
        memberId: MEMBER_ID,
        channel: 'voice',
        channelTier: 'escalation',
        toneSequence: 1,
        dispatch: { incidentType: 'STRUCTURE_FIRE', address: '123 Main St', isTest: false },
      }),
    });
    expect(
      await createChannelWorkerHandler('voice')({
        Records: [{ messageId: 'voice-1', body: voiceBody }],
      } as unknown as SQSEvent),
    ).toEqual({ batchItemFailures: [] });

    expect(providerSends).toEqual([
      ['sms', PHONE],
      ['voice', PHONE],
    ]);
    const metrics = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(metrics.some((line) => line.includes('"NoTargetRegistered"'))).toBe(false);
    expect(metrics.some((line) => line.includes('"SmsSkipped"'))).toBe(false);
  }, 60_000);
});
