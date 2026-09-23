import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildYearEndReport } from './repository.js';

const TABLE_NAME = 'boxalarm-reporting-losap-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('LOSAP year-end aggregation (real DynamoDB via LocalStack, GSI1/GSI3 key schema)', () => {
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
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('aggregates a real roster (GSI3) and per-member point entries (GSI1) end to end', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#MEMBER#MBR-0001`,
          sk: 'METADATA',
          gsi3pk: `DEPT#${DEPT_ID}#MEMBER`,
          gsi3sk: 'MBR-0001',
          memberId: 'MBR-0001',
          status: 'ACTIVE',
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${DEPT_ID}#MEMBER#MBR-0002`,
          sk: 'METADATA',
          gsi3pk: `DEPT#${DEPT_ID}#MEMBER`,
          gsi3sk: 'MBR-0002',
          memberId: 'MBR-0002',
          status: 'PROBATIONARY',
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `MEMBER#MBR-0001#LOSAP_POINT_ENTRY#2026#1`,
          sk: 'METADATA',
          gsi1pk: 'MEMBER#MBR-0001',
          gsi1sk: 'LOSAP_POINT_ENTRY#2026#1',
          points: 4,
          ruleVersionId: 'RULE-2026',
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `MEMBER#MBR-0001#LOSAP_POINT_ENTRY#2026#2`,
          sk: 'METADATA',
          gsi1pk: 'MEMBER#MBR-0001',
          gsi1sk: 'LOSAP_POINT_ENTRY#2026#2',
          points: 6,
          ruleVersionId: 'RULE-2026-REVISED',
        },
      }),
    );

    const report = await buildYearEndReport(client, TABLE_NAME, DEPT_ID, 2026);

    expect(report.members).toEqual([
      { memberId: 'MBR-0001', totalPoints: 10, entryCount: 2, unreadableEntryCount: 0 },
    ]);
    expect(report.hasData).toBe(true);
    expect(report.totalUnreadableEntryCount).toBe(0);
  });
});
