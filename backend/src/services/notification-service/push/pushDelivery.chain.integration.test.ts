import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CreateTopicCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SubscribeCommand } from '@aws-sdk/client-sns';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import type { SQSEvent } from 'aws-lambda';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The M7 chain, end to end against real SNS/SQS/DynamoDB (LocalStack):
 *
 *   apparatus.defect.reported (OUT_OF_SERVICE) -> apparatusDefectConsumer (inbox + mute read +
 *   publish to the real notification-push topic) -> raw SNS->SQS subscription -> the push
 *   worker (reads the member's PUSH devices from the platform member row) -> the injected
 *   transport captures a strictly non-critical FCM send.
 *
 * Before the worker existed, this publish succeeded and the push was dropped unseen — the
 * exact defect this chain pins closed.
 */

const PLATFORM_TABLE = 'platform-table';
const DEPT = 'NICHOLS';
const MEMBER = 'OFF-1';
const FCM_TOKEN = 'fcm-token-off-1';

describe('non-critical push chain: immediate OOS defect -> topic -> worker -> transport', () => {
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
      new CreateTopicCommand({ Name: 'boxalarm-test-notification-push' }),
    );
    topicArn = topic.TopicArn!;
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: 'boxalarm-test-notification-push-queue' }),
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
    process.env.PLATFORM_SERVICE_TABLE_NAME = PLATFORM_TABLE;
    process.env.NOTIFICATION_PUSH_TOPIC_ARN = topicArn;
    process.env.NOTIFICATION_SES_FROM_ADDRESS = 'notifications@boxalarm.dev';
    process.env.FCM_SECRET_ID = 'boxalarm-test-push-fcm-credentials';
    process.env.APNS_SECRET_ID = 'boxalarm-test-push-apns-credentials';
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

  function defectEvent(eventId: string): SQSEvent {
    return {
      Records: [
        {
          messageId: `bus-${eventId}`,
          body: JSON.stringify({
            version: '0',
            'detail-type': 'apparatus.defect.reported',
            source: 'apparatus-service',
            detail: {
              eventId,
              eventType: 'apparatus.defect.reported',
              eventTime: new Date().toISOString(),
              correlationId: `corr-${eventId}`,
              schemaVersion: '1.0',
              source: 'apparatus-service',
              payload: {
                defectId: `DEF-${eventId}`,
                apparatusId: 'APP-1',
                unitLabel: 'E1',
                reportedByMemberId: 'MBR-9',
                severity: 'OUT_OF_SERVICE',
                outOfService: true,
                deptId: DEPT,
              },
            },
          }),
        },
      ],
    } as unknown as SQSEvent;
  }

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

  it('delivers the out-of-service push to the member device, strictly non-critical', async () => {
    await docClient.send(
      new PutCommand({
        TableName: PLATFORM_TABLE,
        Item: {
          pk: `DEPT#${DEPT}#MEMBER#${MEMBER}`,
          sk: 'METADATA',
          memberId: MEMBER,
          deptId: DEPT,
          status: 'ACTIVE',
          roles: ['OFFICER'],
          gsi3pk: `DEPT#${DEPT}#MEMBER`,
          gsi3sk: `OFFICER#${MEMBER}`,
          contactChannels: [
            { channel: 'PUSH', platform: 'FCM', token: FCM_TOKEN, valid: true },
            { channel: 'PUSH', platform: 'FCM', token: 'dead-token', valid: false },
          ],
        },
      }),
    );

    // The consumer publishes through the module-level SNS client: seed it with LocalStack's.
    const { createSnsClient } = await import('../channelSender.js');
    createSnsClient(sns);
    const { handler: consumeDefect } = await import('../events/apparatusDefectConsumer.js');
    await consumeDefect(defectEvent('evt-1'));

    // The inbox record is written whether or not any push device exists.
    const inbox = await docClient.send(
      new QueryCommand({
        TableName: PLATFORM_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: {
          ':pk': `DEPT#${DEPT}#MEMBER#${MEMBER}`,
          ':sk': `NOTIF#${MEMBER}#`,
        },
      }),
    );
    expect(inbox.Items).toHaveLength(1);

    const workerEvent = await drainQueue();
    const sendFcm = vi.fn().mockResolvedValue({ outcome: 'sent' });
    const sendApns = vi.fn();
    const { createPushWorkerHandler } = await import('./worker.js');
    const worker = createPushWorkerHandler({ sendFcm, sendApns, secretsClient: {} as never });

    const result = await worker(workerEvent);

    expect(result.batchItemFailures).toEqual([]);
    expect(sendApns).not.toHaveBeenCalled();
    expect(sendFcm).toHaveBeenCalledTimes(1);
    const [fcmMessage, options] = sendFcm.mock.calls[0] as [
      { buildRequest: () => Record<string, unknown> },
      { isTest: boolean },
    ];
    expect(options.isTest).toBe(false);
    const request = fcmMessage.buildRequest();
    const message = request.message as {
      token: string;
      notification?: unknown;
      android: { priority: string };
      data: Record<string, string>;
      apns: { payload: { aps: Record<string, unknown> } };
    };
    expect(message.token).toBe(FCM_TOKEN);
    expect(message.notification).toBeUndefined();
    expect(message.android.priority).toBe('NORMAL');
    expect(message.data.category).toBe('digest');
    expect(message.data.path).toBe('/notifications');
    expect(message.data.title).toContain('defect');
    expect(message.apns.payload.aps['interruption-level']).toBe('active');
    expect(JSON.stringify(request)).not.toMatch(/critical/i);
    expect(JSON.stringify(request)).not.toMatch(/DISPATCH/);
  }, 60_000);
});
