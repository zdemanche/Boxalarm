import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildChecklistRunItem,
  parseChecklistRunItem,
  validateSubmitCheckBody,
} from './checklistRun.js';

const TABLE_NAME = 'boxalarm-test-apparatus-table';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
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
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function documentClientForTest(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}

describe('CHECKLIST_RUN key schema (real DynamoDB via LocalStack)', () => {
  it('round-trips pk/sk/gsi3pk/gsi3sk through a real DynamoDB PutItem and GetItem/Query', async () => {
    const validation = validateSubmitCheckBody({
      templateId: 'template-1',
      completedBy: 'member-1',
      completedAt: 1798052000,
      durationSeconds: 82,
      idempotencyKey: 'idem-1',
      itemResults: [{ code: 'BRAKES', pass: true }],
    });
    if (!validation.ok) {
      throw new Error('expected valid body');
    }
    const item = buildChecklistRunItem(DEPT_ID, 'apparatus-1', validation.value);
    const doc = documentClientForTest();

    await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    const fetched = await doc.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'DEPT#dept-001#APPARATUS#apparatus-1', sk: 'CHECK#1798052000' },
        ConsistentRead: true,
      }),
    );
    expect(fetched.Item).toBeDefined();
    const parsed = parseChecklistRunItem(
      fetched.Item as Record<string, unknown>,
      'apparatus-1',
      DEPT_ID,
    );
    expect(parsed.completedBy).toBe('member-1');
    expect(parsed.completedAt).toBe(1798052000);
    expect(parsed.durationSeconds).toBe(82);

    const queried = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': 'DEPT#dept-001#CHECKLIST_RUN' },
      }),
    );
    expect(queried.Items).toHaveLength(1);
    expect(queried.Items?.[0]?.sk).toBe('CHECK#1798052000');

    doc.destroy();
  }, 60_000);
});
