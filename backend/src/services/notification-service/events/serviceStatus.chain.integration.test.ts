import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { EventBridgeClient, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { Context, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minor 10, end to end against real DynamoDB/SNS/SQS (LocalStack):
 *
 *   PUT service-status (the real setServiceStatus write, outbox row in the same transaction)
 *   -> the real platform outbox drain -> EventBridge entry, delivered as the rule target
 *   would -> apparatusStatusConsumer (inbox record + publish to the real notification-push
 *   topic) -> raw SNS->SQS -> the push worker -> the injected transport captures a strictly
 *   non-critical send for the officer's device.
 */

const PLATFORM_TABLE = 'platform-table';
const DEPT = 'NICHOLS';
const OFFICER = 'LT-1';
const FCM_TOKEN = 'fcm-token-lt-1';
const deptId = toVerifiedDeptId({ deptId: DEPT });

describe('service-status change chain: route write -> event -> inbox + non-critical push', () => {
  let container: StartedLocalStackContainer;
  let docClient: DynamoDBDocumentClient;
  let sns: SNSClient;
  let sqs: SQSClient;
  let topicArn: string;
  let queueUrl: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:3').start();
    const aws = {
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    };
    const lowLevel = new DynamoDBClient(aws);
    docClient = DynamoDBDocumentClient.from(lowLevel, {
      marshallOptions: { removeUndefinedValues: true },
    });
    await lowLevel.send(
      new CreateTableCommand({
        TableName: PLATFORM_TABLE,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'gsi3pk', AttributeType: 'S' },
          { AttributeName: 'gsi3sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI3',
            KeySchema: [
              { AttributeName: 'gsi3pk', KeyType: 'HASH' },
              { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );

    sns = new SNSClient(aws);
    sqs = new SQSClient(aws);
    const topic = await sns.send(
      new CreateTopicCommand({ Name: 'boxalarm-chain-notification-push' }),
    );
    topicArn = topic.TopicArn!;
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: 'boxalarm-chain-notification-push-queue' }),
    );
    queueUrl = queue.QueueUrl!;
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: 'sqs',
        Endpoint: attributes.Attributes!.QueueArn!,
        Attributes: { RawMessageDelivery: 'true' },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    // The real outbox drain reads its own config (readOutboxDrainConfig).
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.PLATFORM_TABLE_NAME = PLATFORM_TABLE;
    process.env.PLATFORM_SERVICE_TABLE_NAME = PLATFORM_TABLE;
    process.env.NOTIFICATION_PUSH_TOPIC_ARN = topicArn;
    process.env.NOTIFICATION_SES_FROM_ADDRESS = 'notifications@boxalarm.dev';
    process.env.FCM_SECRET_ID = 'boxalarm-chain-push-fcm-credentials';
    process.env.APNS_SECRET_ID = 'boxalarm-chain-push-apns-credentials';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('../dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function drainQueue(): Promise<SQSEvent> {
    const records: SQSEvent['Records'] = [];
    for (let attempt = 0; attempt < 10 && records.length === 0; attempt += 1) {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
        }),
      );
      for (const message of received.Messages ?? []) {
        records.push({
          messageId: message.MessageId!,
          body: message.Body!,
        } as SQSEvent['Records'][number]);
      }
    }
    expect(records.length).toBeGreaterThan(0);
    return { Records: records };
  }

  it('a manual out-of-service notifies the officer: inbox record and captured push', async () => {
    // The unit registry row the route writes, and the officer with a registered device.
    await docClient.send(
      new PutCommand({
        TableName: PLATFORM_TABLE,
        Item: {
          pk: `DEPT#${DEPT}#APPARATUS#APP-E1`,
          sk: 'METADATA',
          apparatusId: 'APP-E1',
          unitId: 'E1',
          type: 'ENGINE',
          status: 'IN_SERVICE',
          gsi3pk: `DEPT#${DEPT}#APPARATUS`,
          gsi3sk: 'E1',
        },
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: PLATFORM_TABLE,
        Item: {
          pk: `DEPT#${DEPT}#MEMBER#${OFFICER}`,
          sk: 'METADATA',
          memberId: OFFICER,
          deptId: DEPT,
          status: 'ACTIVE',
          roles: ['OFFICER'],
          gsi3pk: `DEPT#${DEPT}#MEMBER`,
          gsi3sk: `OFFICER#${OFFICER}`,
          contactChannels: [{ channel: 'PUSH', platform: 'FCM', token: FCM_TOKEN, valid: true }],
        },
      }),
    );

    // 1. The route's write, against the real table: status + OOS record + outbox row.
    const { setServiceStatus } = await import('../../apparatus-service/repository.js');
    await setServiceStatus(docClient, PLATFORM_TABLE, {
      deptId,
      unitId: 'E1',
      status: 'OUT_OF_SERVICE',
      reason: 'Pump failure',
      changedBy: 'OFF-9',
      correlationId: 'trace-chain',
    });
    const { Items: outboxRows } = await docClient.send(
      new QueryCommand({
        TableName: PLATFORM_TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `DEPT#${DEPT}#OUTBOX` },
        ConsistentRead: true,
      }),
    );
    expect(outboxRows).toHaveLength(1);

    // 2. The real platform drain turns the stream INSERT into the EventBridge entry.
    const entries: PutEventsRequestEntry[] = [];
    const eventBridgeClient = {
      send: vi.fn((command: { input: { Entries: PutEventsRequestEntry[] } }) => {
        entries.push(...command.input.Entries);
        return Promise.resolve({ Entries: command.input.Entries.map(() => ({ EventId: 'e' })) });
      }),
    } as unknown as EventBridgeClient;
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const drain = createOutboxDrainHandler('platform-service', {
      eventBridgeClient,
      ddbClient: docClient,
    });
    await drain(
      {
        Records: [
          {
            eventName: 'INSERT',
            dynamodb: {
              SequenceNumber: '1',
              NewImage: marshall(outboxRows![0] as Record<string, unknown>, {
                removeUndefinedValues: true,
              }),
            },
          },
        ],
      } as unknown as DynamoDBStreamEvent,
      {} as Context,
      () => undefined,
    );
    expect(entries[0]).toMatchObject({
      Source: 'apparatus-service',
      DetailType: 'apparatus.serviceStatus.changed',
    });

    // 3. The consumer, publishing through the real LocalStack topic.
    const { createSnsClient } = await import('../channelSender.js');
    createSnsClient(sns);
    const { handler: consumeStatus } = await import('./apparatusStatusConsumer.js');
    await consumeStatus({
      Records: [
        {
          messageId: 'bus-1',
          body: JSON.stringify({
            version: '0',
            'detail-type': entries[0]!.DetailType,
            source: entries[0]!.Source,
            detail: JSON.parse(entries[0]!.Detail!) as unknown,
          }),
        },
      ],
    } as unknown as SQSEvent);

    const inbox = await docClient.send(
      new QueryCommand({
        TableName: PLATFORM_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: {
          ':pk': `DEPT#${DEPT}#MEMBER#${OFFICER}`,
          ':sk': `NOTIF#${OFFICER}#`,
        },
      }),
    );
    expect(inbox.Items).toHaveLength(1);
    expect(inbox.Items?.[0]).toMatchObject({ category: 'apparatus-status' });

    // 4. The worker drains the subscription and the transport captures a non-critical send.
    const workerEvent = await drainQueue();
    const sendFcm = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const sendApns = vi.fn();
    const { createPushWorkerHandler } = await import('../push/worker.js');
    const worker = createPushWorkerHandler({ sendFcm, sendApns, secretsClient: {} as never });

    const result = await worker(workerEvent);

    expect(result.batchItemFailures).toEqual([]);
    expect(sendApns).not.toHaveBeenCalled();
    expect(sendFcm).toHaveBeenCalledTimes(1);
    const request = (
      sendFcm.mock.calls[0]?.[0] as { buildRequest: () => Record<string, unknown> }
    ).buildRequest();
    const message = request.message as {
      token: string;
      android: { priority: string };
      data: Record<string, string>;
    };
    expect(message.token).toBe(FCM_TOKEN);
    expect(message.android.priority).toBe('NORMAL');
    expect(message.data.category).toBe('digest');
    expect(message.data.body).toContain('out of service');
    expect(JSON.stringify(request)).not.toMatch(/critical/i);
  }, 60_000);
});
