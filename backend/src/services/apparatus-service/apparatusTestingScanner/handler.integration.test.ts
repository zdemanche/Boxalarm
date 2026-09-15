import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { runApparatusTestingScan } from './handler.js';

const APPARATUS_TABLE = 'boxalarm-test-apparatus-table';
const DEPT_ID = 'NICHOLS';

let container: StartedLocalStackContainer;
let ddbClient: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:3').start();
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.AWS_REGION = 'us-east-1';
  process.env.PLATFORM_TABLE_NAME = APPARATUS_TABLE;
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.APPARATUS_SCANNER_DEPT_ID = DEPT_ID;
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: APPARATUS_TABLE,
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

  documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' }),
  );
}, 120_000);

afterAll(async () => {
  ddbClient.destroy();
  await container.stop();
});

function scbaMetadataItem(
  scbaUnitId: string,
  nextFlowTestDue: string,
  yearMonth: string,
): Record<string, unknown> {
  return {
    pk: `DEPT#${DEPT_ID}#SCBA#${scbaUnitId}`,
    sk: 'METADATA',
    entityType: 'SCBA_RECORD',
    scbaUnitId,
    apparatusId: 'ENGINE-2',
    cylinderId: 'CYL-0891',
    flowTestDate: '2025-09-20',
    hydroTestDate: '2025-09-20',
    nextFlowTestDue,
    nextHydroTestDue: '2030-01-01',
    gsi2pk: `DEPT#${DEPT_ID}#DUE#SCBA_TEST#${yearMonth}`,
    gsi2sk: `${nextFlowTestDue}#${scbaUnitId}`,
  };
}

describe('apparatus testing scanner (real DynamoDB via LocalStack — F4.7n due-notification delivery)', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('publishes apparatus.test.due only for the unit due inside the lead-time window, not the one outside it (AC3)', async () => {
    await documentClient.send(
      new PutCommand({
        TableName: APPARATUS_TABLE,
        Item: scbaMetadataItem('SCBA-IN', '2026-09-20', '2026-09'),
      }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: APPARATUS_TABLE,
        Item: scbaMetadataItem('SCBA-OUT', '2026-10-20', '2026-10'),
      }),
    );
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runApparatusTestingScan('trace-int-1', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const call = ebSend.mock.calls[0]?.[0] as { input: { Entries: { Detail: string }[] } };
    const detail = JSON.parse(call.input.Entries[0]?.Detail ?? '{}') as {
      payload: { scbaUnitId: string };
    };
    expect(detail.payload.scbaUnitId).toBe('SCBA-IN');
  });

  it('does not re-publish for the same SCBA unit/test-type on a same-day re-run (AC3 dedup guard)', async () => {
    await documentClient.send(
      new PutCommand({
        TableName: APPARATUS_TABLE,
        Item: scbaMetadataItem('SCBA-DEDUP', '2026-09-18', '2026-09'),
      }),
    );

    const firstRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runApparatusTestingScan('trace-int-2', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: firstRun } as unknown as EventBridgeClient,
      now,
    });
    expect(firstRun).toHaveBeenCalledTimes(1);

    const marker = await documentClient.send(
      new GetCommand({
        TableName: APPARATUS_TABLE,
        Key: { pk: `DEPT#${DEPT_ID}#SCBA_TEST_DUE_FLAG#2026-09-14`, sk: 'SCBA#SCBA-DEDUP#SCBA_FLOW' },
      }),
    );
    expect(marker.Item?.publishedAt).toBeDefined();

    const secondRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runApparatusTestingScan('trace-int-3', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: secondRun } as unknown as EventBridgeClient,
      now,
    });

    expect(secondRun).not.toHaveBeenCalled();
  });
});
