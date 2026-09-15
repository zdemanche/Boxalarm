import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  CreateTableCommand,
  DynamoDBClient,
  QueryCommand as LowLevelQueryCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBStreamEvent } from 'aws-lambda';

const TABLE_NAME = 'alerting-table';

function dispatchAlertInsertEvent(dispatchId: string): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: 'INSERT',
        eventID: 'ev-1',
        dynamodb: {
          NewImage: {
            pk: { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` },
            sk: { S: 'METADATA' },
            entityType: { S: 'DISPATCH_ALERT' },
            dispatchId: { S: dispatchId },
            deptId: { S: 'NICHOLS' },
            incidentType: { S: 'STRUCTURE_FIRE' },
            address: { S: '123 Main St' },
            crossStreets: { S: 'Main & Elm' },
            narrative: { S: 'Smoke showing' },
            mapLink: { S: 'https://maps.example/1' },
          },
        },
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

describe('fanout/handler integration (real DynamoDB conditional write — AC2)', () => {
  let container: StartedLocalStackContainer;
  let docClient: DynamoDBDocumentClient;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:3').start();
    const client = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    docClient = DynamoDBDocumentClient.from(client);

    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
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
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = TABLE_NAME;
    process.env.ALERTING_TOPIC_ARN = 'arn:aws:sns:us-east-1:1:boxalarm-dev-alerting-topic.fifo';
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it('collapses a redelivered/racing dispatch to exactly one DELIVERY_RECEIPT per member per channel', async () => {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: 'DEPT#NICHOLS#ELIGIBILITY',
          sk: 'MEMBER#mbr-1',
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId: 'mbr-1',
          active: true,
          quals: [],
          roles: [],
          contactChannels: [
            { channel: 'PUSH', token: 'tok-1', platform: 'APNS', valid: true },
            { channel: 'sms', token: '+15551234567' },
          ],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 1000,
        },
      }),
    );

    const snsCalls: unknown[] = [];
    const deliveredDeduplicationIds = new Set<string>();
    const fakeSns = {
      send: vi.fn((command: unknown) => {
        const input = (command as { input: { MessageDeduplicationId: string } }).input;
        if (deliveredDeduplicationIds.has(input.MessageDeduplicationId)) {
          return Promise.resolve({ MessageId: 'msg-1' });
        }
        deliveredDeduplicationIds.add(input.MessageDeduplicationId);
        snsCalls.push(input);
        return Promise.resolve({ MessageId: 'msg-1' });
      }),
    } as unknown as SNSClient;

    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../eligibility/dynamoClient.js')>();
      return { ...actual, createDynamoClient: () => docClient };
    });
    vi.doMock('./snsClient.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./snsClient.js')>();
      return { ...actual, createSnsClient: () => fakeSns };
    });

    const { handler } = await import('./handler.js');
    const dispatchId = `NICHOLS-INT-${Date.now()}`;
    const event = dispatchAlertInsertEvent(dispatchId);

    await Promise.all([handler(event), handler(event), handler(event)]);

    const result = await docClient.send(
      new LowLevelQueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: `DEPT#NICHOLS#DISPATCH#${dispatchId}` } },
      }),
    );
    const receipts = (result.Items ?? []).filter(
      (item) => item.entityType?.S === 'DELIVERY_RECEIPT',
    );
    expect(receipts).toHaveLength(2);
    const channels = receipts.map((item) => item.channel?.S).sort();
    expect(channels).toEqual(['push', 'sms']);
    expect(snsCalls).toHaveLength(2);
  }, 60_000);
});
