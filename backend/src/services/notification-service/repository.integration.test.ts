import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildDigestSentMarker,
  buildNotificationItem,
  buildPendingItem,
  CERT_EXPIRY_CATEGORY,
  isConditionalCheckFailed,
} from './repository.js';

const TABLE_NAME = 'boxalarm-notification-test-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

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
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
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
  client = DynamoDBDocumentClient.from(base);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe('notification-service repository (real DynamoDB via LocalStack)', () => {
  it('writes a DIGEST_PENDING item findable by the digest job GSI3 department-day query', async () => {
    const today = '2026-09-15';
    const item = buildPendingItem(
      DEPT_ID,
      'MEMBER',
      'MBR-INT-1',
      CERT_EXPIRY_CATEGORY,
      'CERT-INT-1',
      '2027-01-10',
      today,
      Date.now(),
    );

    await client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: TABLE_NAME, Item: item } }] }));

    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': `DEPT#NICHOLS#DIGEST_PENDING#${today}` },
      }),
    );

    expect(result.Items).toHaveLength(1);
    expect(result.Items?.[0]).toMatchObject({ recipientId: 'MBR-INT-1', certId: 'CERT-INT-1' });
  });

  it('rejects a second conditional put of the same DIGESTSENT marker (guard-transact idempotency)', async () => {
    const today = '2026-09-16';
    const marker = buildDigestSentMarker(
      DEPT_ID,
      'MEMBER',
      'MBR-INT-2',
      CERT_EXPIRY_CATEGORY,
      today,
      Date.now(),
    );
    const transact = () =>
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: marker,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );

    await expect(transact()).resolves.toBeDefined();
    await expect(transact()).rejects.toSatisfy((error: unknown) => isConditionalCheckFailed(error));
  });

  it('writes a NOTIFICATION item findable by both the primary key (inbox list) and GSI1 (mark-read lookup)', async () => {
    const createdAt = Date.now();
    const item = buildNotificationItem(
      DEPT_ID,
      'MBR-INT-3',
      'NOTIF-INT-1',
      CERT_EXPIRY_CATEGORY,
      [{ certId: 'CERT-INT-3', expiryDate: '2027-01-10' }],
      createdAt,
    );

    await client.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: TABLE_NAME, Item: item } }] }));

    const listResult = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': 'DEPT#NICHOLS#MEMBER#MBR-INT-3',
          ':prefix': 'NOTIF#',
        },
      }),
    );
    expect(listResult.Items).toHaveLength(1);

    const markReadResult = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk = :gsi1sk',
        ExpressionAttributeValues: {
          ':gsi1pk': 'DEPT#NICHOLS#MEMBER#MBR-INT-3',
          ':gsi1sk': 'NOTIFICATION#NOTIF-INT-1',
        },
      }),
    );
    expect(markReadResult.Items).toHaveLength(1);
    expect(markReadResult.Items?.[0]?.sk).toBe(item.sk);

    const direct = await client.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: item.pk, sk: item.sk } }),
    );
    expect(direct.Item?.readAt).toBeNull();
  });

  it('rejects a duplicate member+role PENDING transact write for the same certId/day (certExpiryConsumer idempotency)', async () => {
    const today = '2026-09-17';
    const now = Date.now();
    const memberPending = buildPendingItem(
      DEPT_ID,
      'MEMBER',
      'MBR-INT-4',
      CERT_EXPIRY_CATEGORY,
      'CERT-INT-4',
      '2027-01-10',
      today,
      now,
    );
    const rolePending = buildPendingItem(
      DEPT_ID,
      'ROLE',
      'TRAINING',
      CERT_EXPIRY_CATEGORY,
      'CERT-INT-4',
      '2027-01-10',
      today,
      now,
      'MBR-INT-4',
    );
    const transact = () =>
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: memberPending,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: TABLE_NAME,
                Item: rolePending,
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );

    await expect(transact()).resolves.toBeDefined();
    await expect(transact()).rejects.toSatisfy((error: unknown) => isConditionalCheckFailed(error));
  });
});
