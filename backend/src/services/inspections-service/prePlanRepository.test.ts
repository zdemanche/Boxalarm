import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  OccupancyNotFoundError,
  PrePlanConflictError,
  PrePlanDependencyError,
  getPrePlan,
  putPrePlan,
} from './prePlanRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-table';

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

const INPUT = {
  siteDiagramFilename: 'diagram.pdf',
  attachmentFilenames: ['photo1.jpg'],
  utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
  hazards: ['PROPANE_TANK'],
};

describe('getPrePlan', () => {
  it('resolves via a single Query against the occupancy partition (AC3)', async () => {
    const item = { pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1', sk: 'PREPLAN#PP-1', prePlanId: 'PP-1' };
    const send = vi.fn().mockResolvedValue({ Items: [item] });
    const result = await getPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toEqual(item);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when no PREPLAN# item exists', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const result = await getPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toBeUndefined();
  });

  it('wraps a DynamoDB failure in PrePlanDependencyError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    await expect(getPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1')).rejects.toThrow(
      PrePlanDependencyError,
    );
  });
});

describe('putPrePlan', () => {
  it('writes the PRE_PLAN item and the outbox record in the same TransactWriteItems call as the occupancy ConditionCheck (AC1+AC4)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] }) // getPrePlan lookup for an existing prePlanId
      .mockResolvedValueOnce({}); // TransactWriteCommand
    const item = await putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT);

    expect(send).toHaveBeenCalledTimes(2);
    const transactCommand = send.mock.calls[1]?.[0] as {
      input: { TransactItems: unknown[] };
    };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    expect(transactItems).toHaveLength(3);
    expect(transactItems[0]).toHaveProperty('ConditionCheck');
    const prePlanPut = transactItems[1]?.Put as { Item: Record<string, unknown> };
    const outboxPut = transactItems[2]?.Put as { Item: Record<string, unknown> };
    expect(prePlanPut.Item.entityType).toBe('PRE_PLAN');
    expect(outboxPut.Item.entityType).toBe('OUTBOX_ENTRY');
    expect(outboxPut.Item.eventType).toBe('inspections.preplan.updated');
    expect(outboxPut.Item.pk).toBe('DEPT#NICHOLS#OUTBOX');
    expect(outboxPut.Item.payload).toMatchObject({
      deptId: DEPT_ID,
      occupancyId: 'OCC-1',
      hazards: INPUT.hazards,
      utilityShutoffs: INPUT.utilityShutoffs,
    });

    expect(item.pk).toBe('DEPT#NICHOLS#OCCUPANCY#OCC-1');
    expect(item.sk).toBe(`PREPLAN#${item.prePlanId}`);
    expect(item.siteDiagramS3Key).toBe(`NICHOLS/PRE_PLAN/${item.prePlanId}/diagram.pdf`);
    expect(item.attachmentS3Keys).toEqual([`NICHOLS/PRE_PLAN/${item.prePlanId}/photo1.jpg`]);
  });

  it('carries attribute_not_exists(sk) on the PRE_PLAN Put when creating (concurrent-create guard)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    await putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT);
    const transactCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    const prePlanPut = transactItems[1]?.Put as { ConditionExpression?: string };
    expect(prePlanPut.ConditionExpression).toBe('attribute_not_exists(sk)');
  });

  it('does not add a create-guard condition on an update Put', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ prePlanId: 'PP-EXISTING' }] })
      .mockResolvedValueOnce({});
    await putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT);
    const transactCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    const prePlanPut = transactItems[1]?.Put as { ConditionExpression?: string };
    expect(prePlanPut.ConditionExpression).toBeUndefined();
  });

  it('throws PrePlanConflictError when two concurrent first-time PUTs race (409)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'Transaction cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT)).rejects.toThrow(
      PrePlanConflictError,
    );
  });

  it('reuses the existing prePlanId on an update rather than minting a new one', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ prePlanId: 'PP-EXISTING' }] })
      .mockResolvedValueOnce({});
    const item = await putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT);
    expect(item.prePlanId).toBe('PP-EXISTING');
  });

  it('throws OccupancyNotFoundError when the occupancy ConditionCheck fails (404)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'Transaction cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-missing', INPUT)).rejects.toThrow(
      OccupancyNotFoundError,
    );
  });

  it('wraps a DynamoDB unavailable/throttled failure in PrePlanDependencyError (503)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', INPUT)).rejects.toThrow(
      PrePlanDependencyError,
    );
  });

  it('defaults absent hazards/utilityShutoffs/attachments to empty lists', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const item = await putPrePlan(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1', {
      attachmentFilenames: [],
      utilityShutoffs: [],
      hazards: [],
    });
    expect(item.hazards).toEqual([]);
    expect(item.utilityShutoffs).toEqual([]);
    expect(item.attachmentS3Keys).toEqual([]);
    expect(item.siteDiagramS3Key).toBeNull();
  });
});
