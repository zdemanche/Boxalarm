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

  // Paging review MAJOR-A + mobile review R3-M2: ending early re-pages the member, removes the
  // schedules, and keeps the row so a replayed create is 409 and cannot unpage them again.
  it('mark-off → end early → AVAILABLE in the snapshot, schedules deleted, a replayed create is 409', async () => {
    const member = 'mbr-2';
    const snapshotKey = { pk: `DEPT#${DEPT}#ELIGIBILITY`, sk: `MEMBER#${member}` };
    await docClient.send(
      new PutCommand({
        TableName: ALERTING_TABLE,
        Item: {
          ...snapshotKey,
          entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
          memberId: member,
          active: true,
          quals: [],
          roles: [],
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: Date.now() - 60_000,
        },
      }),
    );
    const schedulerSend = vi.fn().mockResolvedValue({});
    const scheduler = { send: schedulerSend } as unknown as SchedulerClient;
    const published: { Source: string; DetailType: string; Detail: string }[] = [];
    const { createOutboxDrainHandler } = await import('@boxalarm/outbox');
    const drain = createOutboxDrainHandler('platform-service', {
      eventBridgeClient: {
        send: vi.fn((command: { input: { Entries: typeof published } }) => {
          published.push(...command.input.Entries);
          return Promise.resolve({ Entries: command.input.Entries.map(() => ({})) });
        }),
      } as unknown as EventBridgeClient,
      ddbClient: docClient,
    });
    const { handler: consume } = await import('./consumer.js');
    let sequence = 0;
    /** Drains every not-yet-sent outbox row for the member and delivers it to alerting. */
    async function relay(): Promise<void> {
      const { Items = [] } = await docClient.send(
        new QueryCommand({
          TableName: PLATFORM_TABLE,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': `DEPT#${DEPT}#OUTBOX#MEMBER#${member}` },
          ConsistentRead: true,
        }),
      );
      const pending = Items.filter((item) => item.sentAt === undefined || item.sentAt === null);
      const before = published.length;
      for (const row of pending) {
        sequence += 1;
        await drain(
          {
            Records: [
              {
                eventID: `s-${sequence}`,
                eventName: 'INSERT',
                dynamodb: { SequenceNumber: `s-${sequence}`, NewImage: marshall(row) },
              },
            ],
          } as unknown as DynamoDBStreamEvent,
          {} as never,
          () => undefined,
        );
      }
      for (const entry of published.slice(before)) {
        await consume({
          Records: [
            {
              messageId: `m-${sequence}-${entry.Detail.length}`,
              body: JSON.stringify({
                'detail-type': entry.DetailType,
                source: entry.Source,
                detail: JSON.parse(entry.Detail) as unknown,
              }),
            },
          ],
        } as unknown as SQSEvent);
      }
    }
    const snapshotState = async (): Promise<unknown> =>
      (
        await docClient.send(
          new GetCommand({ TableName: ALERTING_TABLE, Key: snapshotKey, ConsistentRead: true }),
        )
      ).Item?.availabilityState;

    const { createAvailability } = await import('../../personnel-service/availability/handler.js');
    const { endMarkoff } = await import('../../personnel-service/availability/markoffs.js');
    const now = Math.floor(Date.now() / 1000);
    const createEvent = {
      pathParameters: { memberId: member },
      headers: {},
      body: JSON.stringify({ startAt: now - 60, endAt: now + 3600 }),
    } as unknown as GuardEvent;
    const principal = { sub: member, deptId: DEPT, 'cognito:groups': 'MEMBER' };

    expect(
      await createAvailability(createEvent, principal, { schedulerClient: scheduler }),
    ).toMatchObject({ statusCode: 201 });
    await relay();
    expect(await snapshotState()).toBe('MARKED_OFF');

    // Timestamps: the end's eventTime must sort after the create's for the snapshot clock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ended = await endMarkoff(
      {
        pathParameters: { memberId: member, markoffId: String(now - 60) },
        headers: {},
      } as unknown as GuardEvent,
      principal,
      { schedulerClient: scheduler },
    );
    expect(ended).toMatchObject({ statusCode: 200 });
    await relay();
    expect(await snapshotState()).toBe('AVAILABLE');
    const deleted = schedulerSend.mock.calls
      .map(([command]) => command as { constructor: { name: string }; input: { Name: string } })
      .filter((command) => command.constructor.name === 'DeleteScheduleCommand')
      .map((command) => command.input.Name);
    expect(deleted).toHaveLength(2);
    expect(deleted.every((name) => name.startsWith('avail-'))).toBe(true);

    const { Item: row } = await docClient.send(
      new GetCommand({
        TableName: PLATFORM_TABLE,
        Key: { pk: `DEPT#${DEPT}#MEMBER#${member}`, sk: `MARKOFF#${now - 60}` },
        ConsistentRead: true,
      }),
    );
    expect(row).toMatchObject({ endedBy: member, cancelled: false });
    expect(row?.endAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    // A replayed original create (offline outbox, double tap) cannot re-create the window.
    expect(
      await createAvailability(createEvent, principal, { schedulerClient: scheduler }),
    ).toMatchObject({ statusCode: 409 });
    await relay();
    expect(await snapshotState()).toBe('AVAILABLE');
  }, 60_000);
});
