import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient, PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  withRegisteredDevice,
  writePushDevices,
} from '../../personnel-service/pushTokens/pushDevices.js';
import { invalidateMemberPush } from '../../platform-service/session-revocation/memberAccessStore.js';
import { resolvePushTargets } from './resolvePushTarget.js';

/**
 * Device-loss integration, producer -> consumer, against a real DynamoDB (LocalStack):
 *
 *   personnel registers the phone and the tablet (writePushDevices)
 *     -> platform device loss removes the phone, or every device (invalidateMemberPush,
 *        through the same writePushDevices)
 *     -> each outbox row, in write order, through the deployed platform outbox drain
 *     -> the alerting-owned consumer (memberUpdatedHandler) -> the eligibility snapshot.
 *
 * The writes run back to back, usually inside one millisecond: before device loss shared
 * writePushDevices' max(now, previous + 1) event time, its event could carry the same time
 * as the registration before it and the projection dropped it as stale - the lost phone
 * kept receiving dispatches.
 */

const ALERTING_TABLE = 'alerting-table';
const PLATFORM_TABLE = 'platform-table';
const DEPT = 'NICHOLS';

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

const PHONE = {
  channel: 'PUSH',
  platform: 'APNS',
  token: 'tok-phone',
  deviceId: 'install-phone',
  valid: true,
} as const;
const TABLET = {
  channel: 'PUSH',
  platform: 'FCM',
  token: 'tok-tablet',
  deviceId: 'install-tablet',
  valid: true,
} as const;

describe('device loss: register phone + tablet -> report lost -> eligibility snapshot', () => {
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
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.doMock('./dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function seedMember(memberId: string): Promise<void> {
    await docClient.send(
      new PutCommand({
        TableName: PLATFORM_TABLE,
        Item: {
          pk: `DEPT#${DEPT}#MEMBER#${memberId}`,
          sk: 'METADATA',
          memberId,
          deptId: DEPT,
          contactChannels: [],
        },
      }),
    );
  }

  /** registerToken's write: one PUSH entry per installation. */
  async function register(memberId: string, device: typeof PHONE | typeof TABLET): Promise<void> {
    const outcome = await writePushDevices(
      docClient,
      PLATFORM_TABLE,
      toVerifiedDeptId({ deptId: DEPT }),
      memberId,
      (current) => withRegisteredDevice(current, { ...device, registeredAt: Date.now() }),
    );
    expect(outcome).toBe('written');
  }

  /** Every outbox row the writes produced, in the order they were written. */
  async function outboxRows(memberId: string): Promise<Record<string, unknown>[]> {
    const { Items } = await docClient.send(
      new QueryCommand({
        TableName: PLATFORM_TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `DEPT#${DEPT}#OUTBOX#${memberId}` },
        ConsistentRead: true,
      }),
    );
    return [...(Items ?? [])].sort((a, b) =>
      String(a.eventTime).localeCompare(String(b.eventTime)),
    );
  }

  /**
   * The deployed drain: stream INSERT of the outbox row -> PutEvents entry. One handler per
   * test - the drain caches its EventBridge client for the module's life.
   */
  async function createDrain(): Promise<
    (outbox: Record<string, unknown>) => Promise<PutEventsRequestEntry>
  > {
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
    return async (outbox) => {
      const before = entries.length;
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
      expect(entries).toHaveLength(before + 1);
      return entries[before]!;
    };
  }

  /** Drains and consumes every outbox row in write order; returns the member's snapshot. */
  async function project(memberId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await outboxRows(memberId);
    // Every write's event is strictly later than the one before it.
    const times = rows.map((row) => Date.parse(String(row.eventTime)));
    expect(new Set(times).size).toBe(times.length);
    const { handler: consume } = await import('./memberUpdatedHandler.js');
    const drain = await createDrain();
    for (const row of rows) {
      const entry = await drain(row);
      expect(entry).toMatchObject({
        Source: 'personnel-service',
        DetailType: 'personnel.member.updated',
      });
      expect(await consume(sqsBodyFrom(entry))).toEqual({ batchItemFailures: [] });
    }
    const { Item } = await docClient.send(
      new GetCommand({
        TableName: ALERTING_TABLE,
        Key: { pk: `DEPT#${DEPT}#ELIGIBILITY`, sk: `MEMBER#${memberId}` },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  function pushEntries(snapshot: Record<string, unknown> | undefined): unknown[] {
    return ((snapshot?.contactChannels as Array<{ channel?: string }> | undefined) ?? []).filter(
      (entry) => entry.channel?.toUpperCase() === 'PUSH',
    );
  }

  it('reporting the phone lost leaves only the tablet in the snapshot, and the tablet is still paged', async () => {
    const memberId = 'sub-phone-lost';
    await seedMember(memberId);
    await register(memberId, PHONE);
    await register(memberId, TABLET);

    await expect(
      invalidateMemberPush(
        docClient,
        PLATFORM_TABLE,
        DEPT,
        memberId,
        'trace-loss',
        'admin-1',
        PHONE.deviceId,
      ),
    ).resolves.toBe('invalidated');

    const snapshot = await project(memberId);
    expect(pushEntries(snapshot)).toEqual([expect.objectContaining(TABLET)]);
    expect(
      resolvePushTargets(snapshot?.contactChannels as Parameters<typeof resolvePushTargets>[0]),
    ).toEqual([{ token: TABLET.token, platform: TABLET.platform, deviceKey: TABLET.deviceId }]);
  }, 60_000);

  it('reporting without a device removes every device from the snapshot', async () => {
    const memberId = 'sub-all-lost';
    await seedMember(memberId);
    await register(memberId, PHONE);
    await register(memberId, TABLET);

    await expect(
      invalidateMemberPush(docClient, PLATFORM_TABLE, DEPT, memberId, 'trace-all', 'admin-1'),
    ).resolves.toBe('invalidated');

    const snapshot = await project(memberId);
    expect(snapshot).toBeDefined();
    expect(pushEntries(snapshot)).toEqual([]);
    expect(
      resolvePushTargets(snapshot?.contactChannels as Parameters<typeof resolvePushTargets>[0]),
    ).toEqual([]);
  }, 60_000);
});
