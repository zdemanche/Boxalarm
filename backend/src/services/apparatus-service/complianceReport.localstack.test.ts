import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { GSI3_INDEX_NAME } from './dynamoClient.js';
import { queryChecklistRunsInRange } from './complianceReport.js';

const TABLE_NAME = 'boxalarm-test-apparatus-compliance';
const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

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
}, 120_000);

afterAll(async () => {
  await container.stop();
});

async function putChecklistRun(apparatusId: string, completedAt: number): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `DEPT#${DEPT_ID}#APPARATUS#${apparatusId}`,
        sk: `CHECK#${completedAt}`,
        entityType: 'CHECKLIST_RUN',
        completedAt,
        gsi3pk: `DEPT#${DEPT_ID}#CHECKLIST_RUN`,
        gsi3sk: String(completedAt).padStart(10, '0'),
      },
    }),
  );
}

describe('queryChecklistRunsInRange (real DynamoDB via LocalStack, P2/P4 regression)', () => {
  it('matches the architecture-typed String gsi3sk via BETWEEN and returns only runs inside the range', async () => {
    await putChecklistRun('APP-ENGINE-1', 1798000000);
    await putChecklistRun('APP-ENGINE-1', 1798100000);
    await putChecklistRun('APP-ENGINE-1', 1798300000);

    const runs = await queryChecklistRunsInRange(
      client,
      TABLE_NAME,
      DEPT_ID,
      1798000000,
      1798100000,
    );

    expect(runs.map((r) => r.completedAt).sort()).toEqual([1798000000, 1798100000]);
    expect(runs.every((r) => r.apparatusId === 'APP-ENGINE-1')).toBe(true);
  });
}, 120_000);
