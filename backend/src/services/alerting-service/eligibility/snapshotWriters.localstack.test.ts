import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';

/**
 * Every writer of MEMBER_ELIGIBILITY_SNAPSHOT against a real DynamoDB. The unit tests use
 * in-memory fakes that accept any expression; DynamoDB does not. Two expressions it rejects
 * shipped that way: the reserved word `roles` used bare (every personnel.member.updated event
 * failed, so no push token, phone or role change reached the snapshot) and `if_not_exists`
 * inside a ConditionExpression (every qual change failed). Both DLQ'd silently.
 */

const TABLE = 'alerting-table';
const DEPT = 'NICHOLS';

function memberUpdated(eventTime: string, payload: Record<string, unknown>): SQSEvent {
  return {
    Records: [
      {
        messageId: `m-${eventTime}`,
        body: JSON.stringify({
          'detail-type': 'personnel.member.updated',
          source: 'personnel-service',
          detail: {
            eventId: `evt-${eventTime}`,
            eventTime,
            eventType: 'personnel.member.updated',
            payload: { deptId: DEPT, ...payload },
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

function eligibilityChanged(
  eventId: string,
  memberId: string,
  qualCode: string,
  currentlyEligible: boolean,
): SQSEvent {
  return {
    Records: [
      {
        messageId: eventId,
        body: JSON.stringify({
          detail: {
            eventId,
            eventTime: new Date().toISOString(),
            eventType: 'personnel.eligibility.changed',
            payload: { deptId: DEPT, memberId, qualCode, currentlyEligible },
          },
        }),
      },
    ],
  } as unknown as SQSEvent;
}

describe('eligibility snapshot writers are accepted by DynamoDB', () => {
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
    docClient = DynamoDBDocumentClient.from(lowLevel);
    await lowLevel.send(
      new CreateTableCommand({
        TableName: TABLE,
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
    process.env.ALERTING_TABLE_NAME = TABLE;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.doMock('./dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./dynamoClient.js')>()),
      createDynamoClient: () => docClient,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function snapshot(memberId: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await docClient.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `DEPT#${DEPT}#ELIGIBILITY`, sk: `MEMBER#${memberId}` },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  it('memberUpdatedHandler: eligibility fields, roles and push devices all land', async () => {
    const { handler } = await import('./memberUpdatedHandler.js');
    await handler(
      memberUpdated('2026-09-14T00:00:01.000Z', { memberId: 'mbr-a', roles: ['MEMBER'] }),
    );
    await handler(
      memberUpdated('2026-09-14T00:00:02.000Z', {
        memberId: 'mbr-a',
        active: true,
        roles: ['MEMBER', 'OFFICER'],
        contactChannels: [{ channel: 'PUSH', platform: 'FCM', token: 'tok-a', valid: true }],
      }),
    );

    expect(await snapshot('mbr-a')).toMatchObject({
      entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
      memberId: 'mbr-a',
      active: true,
      availabilityState: 'AVAILABLE',
      quals: [],
      roles: ['MEMBER', 'OFFICER'],
      contactChannels: [{ channel: 'PUSH', platform: 'FCM', token: 'tok-a', valid: true }],
    });
  }, 60_000);

  it('eligibilityChangedConsumer: a qual is added to a new, a qual-less and an existing snapshot', async () => {
    const { handler: memberHandler } = await import('./memberUpdatedHandler.js');
    const { handler } = await import('./eligibilityChangedConsumer.js');

    // No snapshot yet.
    await handler(eligibilityChanged('q-1', 'mbr-b', 'INTERIOR', true), {} as never, () => {});
    expect((await snapshot('mbr-b'))?.quals).toEqual(['INTERIOR']);

    // A snapshot the member.updated consumer created (quals seeded to []).
    await memberHandler(
      memberUpdated('2026-09-14T00:00:03.000Z', { memberId: 'mbr-c', active: true }),
    );
    await handler(eligibilityChanged('q-2', 'mbr-c', 'DRIVER', true), {} as never, () => {});
    await handler(eligibilityChanged('q-3', 'mbr-c', 'INTERIOR', true), {} as never, () => {});
    expect((await snapshot('mbr-c'))?.quals).toEqual(['DRIVER', 'INTERIOR']);
    expect((await snapshot('mbr-c'))?.roles).toEqual([]);
  }, 60_000);
});
