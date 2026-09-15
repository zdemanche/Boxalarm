import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { runConsumableReorderScan } from './handler.js';

const TABLE = 'boxalarm-test-platform-table';
const DEPT_ID = 'NICHOLS';

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.PLATFORM_TABLE_NAME = TABLE;
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.INVENTORY_REORDER_SCANNER_DEPT_ID = DEPT_ID;
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: TABLE,
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

  documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function consumableItem(
  itemId: string,
  stockLevel: number,
  reorderThreshold: number,
): Record<string, unknown> {
  return {
    pk: `DEPT#${DEPT_ID}#CONSUMABLE#${itemId}`,
    sk: 'METADATA',
    entityType: 'CONSUMABLE_STOCK',
    itemId,
    deptId: DEPT_ID,
    itemName: `Item ${itemId}`,
    stockLevel,
    reorderThreshold,
    gsi3pk: `DEPT#${DEPT_ID}#CONSUMABLE`,
    gsi3sk: itemId,
  };
}

describe('consumable reorder scanner (real DynamoDB via LocalStack) — inventory.reorder.due event contract', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('publishes inventory.reorder.due with the exact envelope and payload shape for the item at/below threshold, not the restocked one (AC1, AC2, AC3)', async () => {
    await documentClient.send(
      new PutCommand({ TableName: TABLE, Item: consumableItem('GLOVES-L', 3, 5) }),
    );
    await documentClient.send(
      new PutCommand({ TableName: TABLE, Item: consumableItem('STRAPS-M', 20, 5) }),
    );
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runConsumableReorderScan('trace-int-1', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const call = ebSend.mock.calls[0]?.[0] as {
      input: { Entries: { DetailType: string; Source: string; Detail: string }[] };
    };
    const entry = call.input.Entries[0];
    expect(entry?.DetailType).toBe('inventory.reorder.due');
    expect(entry?.Source).toBe('inventory-service');
    const detail = JSON.parse(entry?.Detail ?? '{}') as {
      eventId: string;
      eventTime: string;
      eventType: string;
      source: string;
      correlationId: string;
      schemaVersion: string;
      payload: {
        itemId: string;
        itemName: string;
        currentQty: number;
        reorderThreshold: number;
        deptId: string;
      };
    };
    expect(typeof detail.eventId).toBe('string');
    expect(typeof detail.eventTime).toBe('string');
    expect(detail.eventType).toBe('inventory.reorder.due');
    expect(detail.source).toBe('inventory-service');
    expect(detail.correlationId).toBe('trace-int-1');
    expect(detail.schemaVersion).toBe('1.0');
    expect(detail.payload).toEqual({
      itemId: 'GLOVES-L',
      itemName: 'Item GLOVES-L',
      currentQty: 3,
      reorderThreshold: 5,
      deptId: 'NICHOLS',
    });
  });

  it('does not re-publish for the same item on a same-day re-run (AC2/AC3 dedup guard)', async () => {
    await documentClient.send(
      new PutCommand({ TableName: TABLE, Item: consumableItem('GLOVES-DEDUP', 2, 5) }),
    );

    const firstRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runConsumableReorderScan('trace-int-2', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: firstRun } as unknown as EventBridgeClient,
      now,
    });
    expect(firstRun).toHaveBeenCalledTimes(1);

    const marker = await documentClient.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `DEPT#${DEPT_ID}#CONSUMABLE_REORDER_FLAG#2026-09-14`, sk: 'CONSUMABLE#GLOVES-DEDUP' },
      }),
    );
    expect(marker.Item?.publishedAt).toBeDefined();

    const secondRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runConsumableReorderScan('trace-int-3', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: secondRun } as unknown as EventBridgeClient,
      now,
    });

    expect(secondRun).not.toHaveBeenCalled();
  });
});
