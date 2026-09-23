import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { runCertificationExpiryScan } from './handler.js';

const TRAINING_TABLE = 'boxalarm-test-training-table';
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
  process.env.TRAINING_DYNAMO_TABLE_NAME = TRAINING_TABLE;
  process.env.PLATFORM_CONFIG_DYNAMO_TABLE_NAME = CONFIG_TABLE;
  process.env.PLATFORM_EVENT_BUS_NAME = 'boxalarm-test-platform-bus';
  process.env.TRAINING_SCANNER_DEPT_ID = DEPT_ID;
  process.env.AWS_ENDPOINT_URL = container.getConnectionUri();

  ddbClient = new DynamoDBClient({ endpoint: container.getConnectionUri(), region: 'us-east-1' });
  await ddbClient.send(
    new CreateTableCommand({
      TableName: TRAINING_TABLE,
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

function certItem(certId: string, expiryDate: string, yearMonth: string): Record<string, unknown> {
  return {
    pk: `DEPT#${DEPT_ID}#MEMBER#MBR-1`,
    sk: `CERT#${certId}`,
    entityType: 'CERTIFICATION',
    certId,
    memberId: 'MBR-1',
    certType: 'FF1',
    issueDate: '2024-01-01',
    expiryDate,
    issuingAuthority: 'CT DESPP',
    attachmentS3Key: null,
    status: 'CURRENT',
    gsi2pk: `DEPT#${DEPT_ID}#DUE#CERTIFICATION#${yearMonth}`,
    gsi2sk: `${expiryDate}#${certId}`,
  };
}

describe('certification expiry scanner (real DynamoDB via LocalStack)', () => {
  const now = new Date('2026-09-14T00:00:00Z');

  it('publishes only for the cert just inside the lead-time window, not the one just outside (AC1)', async () => {
    await documentClient.send(
      new PutCommand({
        TableName: TRAINING_TABLE,
        Item: certItem('CERT-IN', '2026-09-24', '2026-09'),
      }),
    );
    await documentClient.send(
      new PutCommand({
        TableName: TRAINING_TABLE,
        Item: certItem('CERT-OUT', '2026-10-20', '2026-10'),
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
          value: { certExpiryLeadDays: 10 },
          version: 1,
        },
      }),
    );
    const ebSend = vi.fn().mockResolvedValue({ Entries: [{}] });

    await runCertificationExpiryScan('trace-int-1', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: ebSend } as unknown as EventBridgeClient,
      now,
    });

    expect(ebSend).toHaveBeenCalledTimes(1);
    const call = ebSend.mock.calls[0]?.[0] as { input: { Entries: { Detail: string }[] } };
    const detail = JSON.parse(call.input.Entries[0]?.Detail ?? '{}') as {
      payload: { certId: string };
    };
    expect(detail.payload.certId).toBe('CERT-IN');
  });

  it('does not re-publish for the same cert on a same-day re-run (AC2)', async () => {
    await documentClient.send(
      new PutCommand({
        TableName: TRAINING_TABLE,
        Item: certItem('CERT-DEDUP', '2026-09-20', '2026-09'),
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
          value: { certExpiryLeadDays: 10 },
          version: 1,
        },
      }),
    );

    const firstRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runCertificationExpiryScan('trace-int-2', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: firstRun } as unknown as EventBridgeClient,
      now,
    });

    expect(firstRun).toHaveBeenCalledTimes(1);
    const firstCall = firstRun.mock.calls[0]?.[0] as { input: { Entries: { Detail: string }[] } };
    const firstDetail = JSON.parse(firstCall.input.Entries[0]?.Detail ?? '{}') as {
      payload: { certId: string };
    };
    expect(firstDetail.payload.certId).toBe('CERT-DEDUP');

    const marker = await documentClient.send(
      new GetCommand({
        TableName: TRAINING_TABLE,
        Key: { pk: `DEPT#${DEPT_ID}#CERT_EXPIRY_FLAG#2026-09-14`, sk: 'CERT#CERT-DEDUP' },
      }),
    );
    expect(marker.Item?.publishedAt).toBeDefined();

    const secondRun = vi.fn().mockResolvedValue({ Entries: [{}] });
    await runCertificationExpiryScan('trace-int-3', {
      dynamoClient: documentClient,
      eventBridgeClient: { send: secondRun } as unknown as EventBridgeClient,
      now,
    });

    expect(secondRun).not.toHaveBeenCalled();
  });
});
