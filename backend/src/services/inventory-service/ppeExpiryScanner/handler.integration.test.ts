import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { runPpeExpiryScan } from './handler.js';

const INVENTORY_TABLE = 'boxalarm-test-inventory-table';
const CONFIG_TABLE = 'boxalarm-test-platform-config-table';
const DEPT_ID = 'NICHOLS';

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.PLATFORM_TABLE_NAME = INVENTORY_TABLE;
  process.env.PLATFORM_CONFIG_DYNAMO_TABLE_NAME = CONFIG_TABLE;
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.PPE_SCANNER_DEPT_ID = DEPT_ID;
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: INVENTORY_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await ddbClient.send(
    new CreateTableCommand({
      TableName: CONFIG_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );

  documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function ppeItem(
  ppeItemId: string,
  nfpaExpiryDate: string,
  yearMonth: string,
  memberId = 'MBR-1',
): Record<string, unknown> {
  return {
    pk: `DEPT#${DEPT_ID}#MEMBER#${memberId}`,
    sk: `PPE#${ppeItemId}`,
    entityType: 'PPE_ASSIGNMENT',
    ppeItemId,
    memberId,
    itemType: ppeItemId.replace(/-/g, '_'),
    size: '44R',
    issueDate: '2016-01-10',
    nfpaExpiryDate,
    status: 'ISSUED',
    gsi2pk: `DEPT#${DEPT_ID}#DUE#PPE_ASSIGNMENT#${yearMonth}`,
    gsi2sk: `${nfpaExpiryDate}#${ppeItemId}`,
  };
}

describe('ppe expiry scanner delivery (real DynamoDB via LocalStack) — ppe.expiry.due integration', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('publishes only for the item just inside the lead-time window, not the one just outside (AC2)', async () => {
    await documentClient.send(
      new PutCommand({ TableName: INVENTORY_TABLE, Item: ppeItem('TURNOUT-COAT', '2026-09-24', '2026-09') }),
    );
    await documentClient.send(
      new PutCommand({ TableName: INVENTORY_TABLE, Item: ppeItem('HELMET', '2026-10-20', '2026-10') }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: CONFIG_TABLE,
        Item: {
          pk: `DEPT#${DEPT_ID}`,
          sk: 'CONFIG#ALERT_RULES',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'ALERT_RULES',
          value: { ppeExpiryLeadDays: 10 },
          version: 1,
        },
      }),
    );
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runPpeExpiryScan('trace-int-1', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const call = ebSend.mock.calls[0]?.[0] as { input: { Entries: { Detail: string }[] } };
    const detail = JSON.parse(call.input.Entries[0]?.Detail ?? '{}') as {
      payload: { ppeItemId: string; memberId: string };
    };
    expect(detail.payload.ppeItemId).toBe('TURNOUT-COAT');
    expect(detail.payload.memberId).toBe('MBR-1');
  });

  it('does not re-publish for the same item on a same-day re-run — the ppe.expiry.due delivery guard (AC2)', async () => {
    await documentClient.send(
      new PutCommand({ TableName: INVENTORY_TABLE, Item: ppeItem('GLOVES', '2026-09-20', '2026-09') }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: CONFIG_TABLE,
        Item: {
          pk: `DEPT#${DEPT_ID}`,
          sk: 'CONFIG#ALERT_RULES',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'ALERT_RULES',
          value: { ppeExpiryLeadDays: 10 },
          version: 1,
        },
      }),
    );

    const firstRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runPpeExpiryScan('trace-int-2', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: firstRun } as unknown as EventBridgeClient,
      now,
    });

    expect(firstRun).toHaveBeenCalledTimes(1);

    const marker = await documentClient.send(
      new GetCommand({
        TableName: INVENTORY_TABLE,
        Key: { pk: `DEPT#${DEPT_ID}#PPE_EXPIRY_FLAG#2026-09-14`, sk: 'PPE#MBR-1#GLOVES' },
      }),
    );
    expect(marker.Item?.publishedAt).toBeDefined();

    const secondRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runPpeExpiryScan('trace-int-3', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: secondRun } as unknown as EventBridgeClient,
      now,
    });

    expect(secondRun).not.toHaveBeenCalled();
  });

  it('publishes for both members when two members hold the same itemType due the same day (P5 core-harm regression)', async () => {
    await documentClient.send(
      new PutCommand({
        TableName: INVENTORY_TABLE,
        Item: ppeItem('COAT-SHARED', '2026-09-22', '2026-09', 'MBR-10'),
      }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: INVENTORY_TABLE,
        Item: ppeItem('COAT-SHARED', '2026-09-22', '2026-09', 'MBR-11'),
      }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: CONFIG_TABLE,
        Item: {
          pk: `DEPT#${DEPT_ID}`,
          sk: 'CONFIG#ALERT_RULES',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'ALERT_RULES',
          value: { ppeExpiryLeadDays: 10 },
          version: 1,
        },
      }),
    );
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runPpeExpiryScan('trace-int-4', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now,
    });

    expect(ebSend).toHaveBeenCalledTimes(2);
    const memberIds = ebSend.mock.calls.map((call) => {
      const detail = JSON.parse(
        (call[0] as { input: { Entries: { Detail: string }[] } }).input.Entries[0]?.Detail ?? '{}',
      ) as { payload: { memberId: string } };
      return detail.payload.memberId;
    });
    expect(memberIds.sort()).toEqual(['MBR-10', 'MBR-11']);
    const eventIds = ebSend.mock.calls.map((call) => {
      const detail = JSON.parse(
        (call[0] as { input: { Entries: { Detail: string }[] } }).input.Entries[0]?.Detail ?? '{}',
      ) as { eventId: string };
      return detail.eventId;
    });
    expect(eventIds[0]).not.toBe(eventIds[1]);
  });
});
