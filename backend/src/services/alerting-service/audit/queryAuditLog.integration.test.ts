import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryDepartmentAuditLog, queryMemberDeliveryHistory } from './queryAuditLog.js';

const TABLE_NAME = 'alerting-audit-test';
const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('audit log GSI1/GSI2 queries (real DynamoDB via LocalStack, AC1/AC2/AC4)', () => {
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
          { AttributeName: 'gsi2pk', AttributeType: 'S' },
          { AttributeName: 'gsi2sk', AttributeType: 'S' },
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
            IndexName: 'GSI2',
            KeySchema: [
              { AttributeName: 'gsi2pk', KeyType: 'HASH' },
              { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
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

  it('returns only the queried member\'s receipts from GSI1 (AC2)', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'DISPATCH', 'D-1'),
          sk: 'RECEIPT#mbr-201#push#1',
          entityType: 'DELIVERY_RECEIPT',
          dispatchId: 'D-1',
          memberId: 'mbr-201',
          channel: 'push',
          sentAt: 1798000000,
          gsi1pk: 'MEMBER#mbr-201',
          gsi1sk: 'RECEIPT#1798000000#D-1',
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'DISPATCH', 'D-1'),
          sk: 'RECEIPT#mbr-999#push#1',
          entityType: 'DELIVERY_RECEIPT',
          dispatchId: 'D-1',
          memberId: 'mbr-999',
          channel: 'push',
          sentAt: 1798000000,
          gsi1pk: 'MEMBER#mbr-999',
          gsi1sk: 'RECEIPT#1798000000#D-1',
        },
      }),
    );

    const page = await queryMemberDeliveryHistory(client, TABLE_NAME, 'mbr-201');

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.memberId).toBe('mbr-201');
  });

  it('assembles a full per-member per-channel delivery timeline for a dispatch in range via GSI2 + pk fan-out (AC1/AC4)', async () => {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'DISPATCH', 'D-2'),
          sk: 'METADATA',
          entityType: 'DISPATCH_ALERT',
          dispatchId: 'D-2',
          deptId: DEPT_ID,
          dispatchedAt: 1798100000,
          gsi2pk: buildDeptScopedPk(DEPT_ID),
          gsi2sk: 'DISPATCH#1798100000',
        },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: buildDeptScopedPk(DEPT_ID, 'DISPATCH', 'D-2'),
          sk: 'RECEIPT#mbr-301#sms#1',
          entityType: 'DELIVERY_RECEIPT',
          dispatchId: 'D-2',
          memberId: 'mbr-301',
          channel: 'sms',
          sentAt: 1798100010,
          deliveredAt: 1798100020,
          gsi1pk: 'MEMBER#mbr-301',
          gsi1sk: 'RECEIPT#1798100010#D-2',
        },
      }),
    );

    const page = await queryDepartmentAuditLog(client, TABLE_NAME, DEPT_ID, 1798099000, 1798101000);

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.dispatchId).toBe('D-2');
    expect(page.entries[0]?.timeline).toHaveLength(1);
    expect(page.entries[0]?.timeline[0]).toMatchObject({
      entityType: 'DELIVERY_RECEIPT',
      memberId: 'mbr-301',
      channel: 'sms',
      sentAt: 1798100010,
      deliveredAt: 1798100020,
    });
  });

  it('returns an empty entries array for a date range with zero dispatches (core-harm regression)', async () => {
    const page = await queryDepartmentAuditLog(
      client,
      TABLE_NAME,
      DEPT_ID,
      1000000000,
      1000000001,
    );

    expect(page.entries).toEqual([]);
  });
});
