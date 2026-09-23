import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryReceiptsForDispatch, updateDeliveryReceipt } from './deliveryReceiptRepository.js';

const TABLE_NAME = 'alerting-receipts-test';

describe('deliveryReceiptRepository (real DynamoDB, AC1/AC2)', () => {
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
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    client = DynamoDBDocumentClient.from(base);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('updates an existing DELIVERY_RECEIPT item once and never fabricates a second item on redelivery (AC1, core-harm)', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-1798000000';
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `DEPT#${deptId}#DISPATCH#${dispatchId}`,
          sk: 'RECEIPT#MBR-0012#push#1',
          entityType: 'DELIVERY_RECEIPT',
          dispatchId,
          memberId: 'MBR-0012',
          deptId,
          channel: 'push',
          toneSequence: 1,
          sentAt: 1798000003,
        },
      }),
    );

    const input = {
      deptId,
      dispatchId,
      memberId: 'MBR-0012',
      channel: 'push' as const,
      toneSequence: 1,
      deliveredAt: 1798000004,
    };
    const first = await updateDeliveryReceipt(client, TABLE_NAME, input);
    const second = await updateDeliveryReceipt(client, TABLE_NAME, input);
    expect(first).toEqual({ outcome: 'updated' });
    expect(second).toEqual({ outcome: 'updated' });

    const records = await queryReceiptsForDispatch(client, TABLE_NAME, deptId, dispatchId);
    const pushReceipts = records.filter((r) => r.memberId === 'MBR-0012' && r.channel === 'push');
    expect(pushReceipts).toHaveLength(1);
    expect(pushReceipts[0]?.deliveredAt).toBe(1798000004);
  });

  it('returns not_found (never creates an item) when no matching DELIVERY_RECEIPT row exists for the channel attempt', async () => {
    const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
    const dispatchId = 'NICHOLS-4471-1798000001';

    const result = await updateDeliveryReceipt(client, TABLE_NAME, {
      deptId,
      dispatchId,
      memberId: 'MBR-9999',
      channel: 'sms',
      toneSequence: 1,
      deliveredAt: 1798000004,
    });

    expect(result).toEqual({ outcome: 'not_found' });
    const records = await queryReceiptsForDispatch(client, TABLE_NAME, deptId, dispatchId);
    expect(records).toHaveLength(0);
  });
});
