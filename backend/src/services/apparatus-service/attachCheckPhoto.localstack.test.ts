import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Decision, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuardEvent } from '@boxalarm/authz';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import { createAttachCheckPhotoHandler } from './attachCheckPhoto.js';

// A truck-check photo on a real table: the CHECK_PHOTO row + audit row commit together, and a
// replay (the outbox re-sending after a lost response or an expired link) writes nothing new.
const TABLE_NAME = 'boxalarm-test-apparatus-check-photo';

let container: StartedLocalStackContainer;
let client: DynamoDBDocumentClient;

beforeAll(async () => {
  process.env.PLATFORM_ASSETS_BUCKET_NAME = 'assets-bucket';
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
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
          IndexName: GSI3_INDEX_NAME,
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
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'DEPT#dept-001#APPARATUS#APP-E1',
        sk: 'METADATA',
        apparatusId: 'APP-E1',
        unitId: 'E1',
        gsi3pk: 'DEPT#dept-001#APPARATUS',
        gsi3sk: 'E1',
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await container.stop();
});

function event(filename: string): GuardEvent {
  return {
    version: '2.0',
    headers: { authorization: 'Bearer token' },
    pathParameters: { unitId: 'E1', checkKey: 'check-77' },
    body: JSON.stringify({ itemCode: 'SCBA', photo: { filename } }),
    requestContext: {
      authorizer: { lambda: { sub: 'm-1', deptId: 'dept-001', 'cognito:groups': 'MEMBER' } },
    },
  } as unknown as GuardEvent;
}

describe('check photo (LocalStack)', () => {
  it('stores one photo row and one audit row; a replay re-signs without writing again', async () => {
    const handler = createAttachCheckPhotoHandler({
      client,
      tableName: TABLE_NAME,
      now: () => 1798050000,
      presign: (_bucket, key) => Promise.resolve(`https://signed/${key}`),
      authzClient: {
        send: vi.fn().mockResolvedValue({ decision: Decision.ALLOW }),
      } as unknown as VerifiedPermissionsClient,
    });

    const first = await handler(event('scba.jpg'));
    const replay = await handler(event('scba.jpg'));

    expect(first).toMatchObject({ statusCode: 201 });
    expect(replay).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((replay as { body: string }).body)).toMatchObject({
      photoS3Key: 'dept-001/check/APP-E1/check-77/SCBA/scba.jpg',
      uploadUrl: 'https://signed/dept-001/check/APP-E1/check-77/SCBA/scba.jpg',
    });
    const photos = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': 'DEPT#dept-001#APPARATUS#APP-E1',
          ':prefix': 'CHECK_PHOTO#check-77#',
        },
      }),
    );
    expect(photos.Items).toHaveLength(1);
    const audit = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'DEPT#dept-001#AUDIT#2026-12-23' },
      }),
    );
    expect(audit.Items?.filter((i) => i.mutatedEntityType === 'CHECK_PHOTO')).toHaveLength(1);
  });
});
