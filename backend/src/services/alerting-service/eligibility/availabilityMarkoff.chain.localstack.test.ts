import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import type { GuardEvent } from '@boxalarm/authz';

/**
 * Post-merge: availability mark-off rows had no eventTime/source/schemaVersion, so the platform
 * drain dropped every one and a marked-off member stayed AVAILABLE in the alerting snapshot.
 * This drives the real chain against a real DynamoDB: the mark-off handler writes its rows,
 * the OUTBOX_ENTRY is read back exactly as stored and handed to the real drain as its stream
 * INSERT, the published event goes to the real availability consumer, and the alerting
 * snapshot must read MARKED_OFF.
 */

const PLATFORM_TABLE = 'platform-table';
const ALERTING_TABLE = 'alerting-table';
const DEPT = 'NICHOLS';
const MEMBER = 'mbr-1';

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

describe('availability mark-off → outbox drain → alerting snapshot (LocalStack)', () => {
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
    await createTable(lowLevel, PLATFORM_TABLE);
    await createTable(lowLevel, ALERTING_TABLE);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(() => {
    vi.resetModules();
    process.env.PLATFORM_TABLE_NAME = PLATFORM_TABLE;
    process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-dev-platform-bus';
    process.env.ALERTING_TABLE_NAME = ALERTING_TABLE;
    process.env.AVAILABILITY_EXPIRY_HANDLER_ARN = 'arn:aws:lambda:us-east-1:1:function:expiry';
    process.env.AVAILABILITY_SCHEDULER_ROLE_ARN = 'arn:aws:iam::1:role/scheduler';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('../../personnel-service/availability/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<
        typeof import('../../personnel-service/availability/dynamoClient.js')
      >()),
      createDdbClient: () => docClient,
    }));
    vi.doMock('./dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../../personnel-service/availability/dynamoClient.js');
    vi.doUnmock('./dynamoClient.js');
    vi.restoreAllMocks();
  });

  it('a member marking off now is MARKED_OFF in the alerting snapshot, and the outbox row is marked sent', async () => {
    await docClient.send(
      new PutCommand({
        TableName: ALERTING_TABLE,
        Item: {
          pk: `DEPT#${DEPT}#ELIGIBILITY`,
          sk: `MEMBER#${MEMBER}`,
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId: MEMBER,
          active: true,
          quals: [],
          roles: [],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: Date.now() - 60_000,
        },
      }),
    );

    const { createAvailability } = await import('../../personnel-service/availability/handler.js');
    const now = Math.floor(Date.now() / 1000);
    const created = await createAvailability(
      {
        pathParameters: { memberId: MEMBER },
        headers: {},
        body: JSON.stringify({ startAt: now - 60, endAt: now + 3600, reason: 'Vacation' }),
      } as unknown as GuardEvent,
      { sub: MEMBER, deptId: DEPT },
      {
        schedulerClient: {
          send: vi.fn().mockResolvedValue({}),
        } as unknown as SchedulerClient,
      },
    );
    expect(created).toMatchObject({ statusCode: 201 });

    // The OUTBOX_ENTRY exactly as DynamoDB stored it, delivered as the stream would.
    const { Items = [] } = await docClient.send(
      new QueryCommand({
        TableName: PLATFORM_TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `DEPT#${DEPT}#OUTBOX#MEMBER#${MEMBER}` },
        ConsistentRead: true,
      }),
    );
    const outboxRow = Items.find((item) => item.entityType === 'OUTBOX_ENTRY');
    expect(outboxRow).toBeDefined();
    const stream = {
      Records: [
        {
          eventID: 'seq-1',
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: 'seq-1', NewImage: marshall(outboxRow!) },
        },
      ],
    } as unknown as DynamoDBStreamEvent;

    const published: { Source: string; DetailType: string; Detail: string }[] = [];
    const eventBridge = {
      send: vi.fn((command: { input: { Entries: typeof published } }) => {
        published.push(...command.input.Entries);
        return Promise.resolve({ Entries: command.input.Entries.map(() => ({})) });
      }),
    } as unknown as EventBridgeClient;
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const drain = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: eventBridge,
      ddbClient: docClient,
    });
    await expect(drain(stream, {} as never, () => undefined)).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      Source: 'personnel-service',
      DetailType: 'personnel.availability.changed',
    });

    const { handler: consume } = await import('./consumer.js');
    await consume({
      Records: [
        {
          messageId: 'msg-1',
          body: JSON.stringify({
            'detail-type': published[0]!.DetailType,
            source: published[0]!.Source,
            detail: JSON.parse(published[0]!.Detail) as unknown,
          }),
        },
      ],
    } as unknown as SQSEvent);

    const { Item: snapshot } = await docClient.send(
      new GetCommand({
        TableName: ALERTING_TABLE,
        Key: { pk: `DEPT#${DEPT}#ELIGIBILITY`, sk: `MEMBER#${MEMBER}` },
        ConsistentRead: true,
      }),
    );
    expect(snapshot?.availabilityState).toBe('MARKED_OFF');

    const { Item: sentRow } = await docClient.send(
      new GetCommand({
        TableName: PLATFORM_TABLE,
        Key: { pk: outboxRow!.pk as string, sk: outboxRow!.sk as string },
        ConsistentRead: true,
      }),
    );
    expect(typeof sentRow?.sentAt).toBe('number');
  }, 60_000);
});
