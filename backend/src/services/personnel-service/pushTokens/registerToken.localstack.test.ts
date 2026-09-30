import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { ContactChannelEntry } from './pushDevices.js';

const TABLE_NAME = 'personnel-push-installation-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function principal(sub: string): CedarPrincipalContext {
  return { sub, deptId: 'NICHOLS', 'cognito:groups': 'member' };
}

function registerEvent(memberId: string, body: unknown): GuardEvent {
  return {
    version: '2.0',
    routeKey: 'POST /api/v1/personnel/members/{memberId}/push-tokens',
    rawPath: `/api/v1/personnel/members/${memberId}/push-tokens`,
    rawQueryString: '',
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { lambda: principal(memberId) } },
  } as unknown as GuardEvent;
}

// M3: a station phone signed out of by member A with no signal (A's revoke never landed), then
// signed in to by member B. B's registration must take the installation off A - in the member
// row and through A's own personnel.member.updated outbox row, which is what the alerting
// eligibility snapshot is built from.
describe('push registration releases the installation from other members (real DynamoDB via LocalStack)', () => {
  let container: StartedLocalStackContainer;
  let client: DynamoDBDocumentClient;

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4').start();
    const base = new DynamoDBClient({
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await base.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: 'PAY_PER_REQUEST',
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
      }),
    );
    client = DynamoDBDocumentClient.from(base);
    process.env.PERSONNEL_TABLE_NAME = TABLE_NAME;
    vi.doMock('../dynamoClient.js', () => ({
      createDynamoClient: () => client,
      readPersonnelConfig: () => ({ tableName: TABLE_NAME }),
    }));
    vi.doMock('@boxalarm/authz', async () => {
      const actual = await vi.importActual<typeof import('@boxalarm/authz')>('@boxalarm/authz');
      return { ...actual, withAuthorization: (inner: unknown) => inner };
    });
  }, 120_000);

  afterAll(async () => {
    vi.doUnmock('../dynamoClient.js');
    vi.doUnmock('@boxalarm/authz');
    await container.stop();
  });

  async function putMember(memberId: string, contactChannels: ContactChannelEntry[] = []) {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'MEMBER', memberId),
          sk: 'METADATA',
          entityType: 'MEMBER',
          memberId,
          gsi3pk: buildDeptScopedPk(DEPT_ID, 'MEMBER'),
          gsi3sk: `Lastname#${memberId}`,
          contactChannels,
        },
      }),
    );
  }

  async function pushDevicesOf(memberId: string): Promise<ContactChannelEntry[]> {
    const result = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: buildDeptScopedPk(DEPT_ID, 'MEMBER', memberId), sk: 'METADATA' },
        ConsistentRead: true,
      }),
    );
    return ((result.Item?.contactChannels as ContactChannelEntry[] | undefined) ?? []).filter(
      (entry) => entry.channel === 'PUSH',
    );
  }

  async function outboxPayloads(memberId: string): Promise<Record<string, unknown>[]> {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': buildDeptScopedPk(DEPT_ID, 'OUTBOX', memberId) },
      }),
    );
    return (result.Items ?? [])
      .filter((item) => item.eventType === 'personnel.member.updated')
      .map((item) => item.payload as Record<string, unknown>);
  }

  async function register(memberId: string, body: unknown): Promise<number> {
    const { handler } = await import('./registerToken.js');
    const result = await (
      handler as unknown as (
        e: GuardEvent,
        p: CedarPrincipalContext,
      ) => Promise<{ statusCode: number }>
    )(registerEvent(memberId, body), principal(memberId));
    return result.statusCode;
  }

  it('B registering the station phone removes it from A, keeps A’s other devices, and emits A’s update', async () => {
    const station = { platform: 'FCM', token: 'tok-station', deviceId: 'station-phone' };
    const aPersonal = {
      channel: 'PUSH',
      platform: 'APNS',
      token: 'tok-a-personal',
      deviceId: 'a-personal',
      registeredAt: 1,
    };
    await putMember('mbr-a', [aPersonal]);
    await putMember('mbr-b');
    await putMember('mbr-other', [
      { channel: 'PUSH', platform: 'FCM', token: 'tok-other', deviceId: 'other' },
    ]);

    expect(await register('mbr-a', station)).toBe(200);
    expect((await pushDevicesOf('mbr-a')).map((entry) => entry.deviceId).sort()).toEqual([
      'a-personal',
      'station-phone',
    ]);

    // A signs out with no signal: no revoke. B signs in on the same phone.
    expect(await register('mbr-b', station)).toBe(200);

    expect((await pushDevicesOf('mbr-b')).map((entry) => entry.deviceId)).toEqual([
      'station-phone',
    ]);
    expect((await pushDevicesOf('mbr-a')).map((entry) => entry.deviceId)).toEqual(['a-personal']);
    expect((await pushDevicesOf('mbr-other')).map((entry) => entry.deviceId)).toEqual(['other']);

    const aEvents = await outboxPayloads('mbr-a');
    const released = aEvents.find(
      (payload) =>
        (payload.changedBy as { reason?: string } | undefined)?.reason ===
        'INSTALLATION_REREGISTERED',
    );
    expect(released).toMatchObject({
      memberId: 'mbr-a',
      changedBy: { actorId: 'mbr-b', deviceId: 'station-phone' },
    });
    expect(
      (released?.contactChannels as ContactChannelEntry[]).map((entry) => entry.deviceId),
    ).toEqual(['a-personal']);
    expect(await outboxPayloads('mbr-other')).toEqual([]);
  });
});
