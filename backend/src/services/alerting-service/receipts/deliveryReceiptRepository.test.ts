import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryReceiptsForDispatch, updateDeliveryReceipt } from './deliveryReceiptRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });

beforeEach(() => {
  ddbMock.reset();
});

describe('updateDeliveryReceipt (AC1, core-harm)', () => {
  it('sends a conditional UpdateItem targeting sk=RECEIPT#{memberId}#{channel}#{toneSequence}, never a Put', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const result = await updateDeliveryReceipt(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      {
        deptId,
        dispatchId: 'NICHOLS-4471-1798000000',
        memberId: 'MBR-0012',
        channel: 'PUSH',
        toneSequence: 1,
        deliveredAt: 1798000004,
      },
    );

    expect(result).toEqual({ outcome: 'updated' });
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call?.args[0].input.Key).toEqual({
      pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000',
      sk: 'RECEIPT#MBR-0012#PUSH#1',
    });
    expect(call?.args[0].input.ConditionExpression).toBe('attribute_exists(pk)');
    expect(call?.args[0].input.UpdateExpression).toContain(
      'deliveredAt = if_not_exists(deliveredAt, :deliveredAt)',
    );
  });

  it('core-harm: a redelivered webhook for the same channel attempt never fabricates a second item — it is a no-op idempotent update, not a Put', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const input = {
      deptId,
      dispatchId: 'NICHOLS-4471-1798000000',
      memberId: 'MBR-0012',
      channel: 'PUSH' as const,
      toneSequence: 1,
      deliveredAt: 1798000004,
    };

    await updateDeliveryReceipt(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      input,
    );
    await updateDeliveryReceipt(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      input,
    );

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    for (const call of ddbMock.commandCalls(UpdateCommand)) {
      expect(call.args[0].input.Key).toEqual({
        pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000',
        sk: 'RECEIPT#MBR-0012#PUSH#1',
      });
    }
  });

  it('never includes ttl in the UpdateExpression (AC5)', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await updateDeliveryReceipt(ddbMock as unknown as DynamoDBDocumentClient, 'alerting-table', {
      deptId,
      dispatchId: 'NICHOLS-4471-1798000000',
      memberId: 'MBR-0012',
      channel: 'SMS',
      toneSequence: 1,
      failureReason: 'CARRIER_REJECTED',
    });
    const call = ddbMock.commandCalls(UpdateCommand)[0];
    expect(call?.args[0].input.UpdateExpression).not.toContain('ttl');
  });

  it('returns not_found (never creates a new item) when no matching DELIVERY_RECEIPT row exists', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} }));
    const result = await updateDeliveryReceipt(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      {
        deptId,
        dispatchId: 'NICHOLS-4471-1798000000',
        memberId: 'MBR-0012',
        channel: 'VOICE',
        toneSequence: 2,
        deliveredAt: 1798000100,
      },
    );
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('rethrows a non-conditional DynamoDB failure', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('table not reachable'));
    await expect(
      updateDeliveryReceipt(ddbMock as unknown as DynamoDBDocumentClient, 'alerting-table', {
        deptId,
        dispatchId: 'NICHOLS-4471-1798000000',
        memberId: 'MBR-0012',
        channel: 'PUSH',
        toneSequence: 1,
        deliveredAt: 1798000004,
      }),
    ).rejects.toThrow('table not reachable');
  });
});

describe('queryReceiptsForDispatch (AC2)', () => {
  it('queries begins_with(RECEIPT#) on the dispatch pk and maps the item shape', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          memberId: 'MBR-0012',
          channel: 'PUSH',
          toneSequence: 1,
          sentAt: 1798000003,
          deliveredAt: 1798000004,
        },
      ],
    });

    const receipts = await queryReceiptsForDispatch(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      deptId,
      'NICHOLS-4471-1798000000',
    );

    expect(receipts).toEqual([
      {
        memberId: 'MBR-0012',
        channel: 'PUSH',
        toneSequence: 1,
        sentAt: 1798000003,
        deliveredAt: 1798000004,
      },
    ]);
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call?.args[0].input.KeyConditionExpression).toBe(
      'pk = :pk AND begins_with(sk, :prefix)',
    );
    expect(call?.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000',
      ':prefix': 'RECEIPT#',
    });
  });

  it('returns an empty array for a dispatch with no receipts yet', async () => {
    ddbMock.on(QueryCommand).resolves({});
    const receipts = await queryReceiptsForDispatch(
      ddbMock as unknown as DynamoDBDocumentClient,
      'alerting-table',
      deptId,
      'NICHOLS-4471-1798000000',
    );
    expect(receipts).toEqual([]);
  });
});
