import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  FieldCaptureDependencyError,
  FieldCaptureInspectionNotFoundError,
  FieldCaptureOccupancyNotFoundError,
  submitFieldCapture,
  type SubmitFieldCaptureInput,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-table';

const EXISTING_ITEM = {
  pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1',
  sk: 'INSPECTION#INS-1',
  entityType: 'INSPECTION_RECORD' as const,
  scheduledDate: '2026-09-01',
  violations: [],
  nextDueDate: '2026-09-01',
  gsi2pk: 'DEPT#NICHOLS#DUE#INSPECTION_RECORD#2026-09',
  gsi2sk: '2026-09-01#INS-1',
};

function buildInput(overrides: Partial<SubmitFieldCaptureInput> = {}): SubmitFieldCaptureInput {
  return {
    deptId: DEPT_ID,
    occupancyId: 'OCC-1',
    inspectionId: 'INS-1',
    idempotencyKey: 'idem-001',
    violations: [{ code: 'V1', description: 'bad wiring', status: 'open' as const }],
    photoS3Keys: ['NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg'],
    conductedBy: 'member-1',
    submittedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('submitFieldCapture', () => {
  it('attaches to the existing INSPECTION_RECORD via a lock Put + occupancy ConditionCheck + domain Update in one TransactWriteItems call (AC2/AC3)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: EXISTING_ITEM }).mockResolvedValueOnce({});
    const result = await submitFieldCapture(fakeDoc(send), TABLE, buildInput());

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.item.photoS3Keys).toEqual(['NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg']);
      expect(result.item.scheduledDate).toBe('2026-09-01');
      expect(result.item.nextDueDate).toBe('2026-09-01');
    }

    const transactCommand = send.mock.calls[1]?.[0] as { input: { TransactItems: unknown[] } };
    const transactItems = transactCommand.input.TransactItems as Array<Record<string, unknown>>;
    expect(transactItems).toHaveLength(3);

    const lockPut = transactItems[0]?.Put as {
      Item: Record<string, unknown>;
      ConditionExpression: string;
    };
    expect(lockPut.Item.pk).toBe('DEPT#NICHOLS#FIELD_CAPTURE_IDEMPOTENCY#idem-001');
    expect(lockPut.Item.sk).toBe('LOCK');
    expect(lockPut.ConditionExpression).toBe('attribute_not_exists(pk)');

    const occupancyCheck = transactItems[1]?.ConditionCheck as {
      Key: Record<string, unknown>;
      ConditionExpression: string;
    };
    expect(occupancyCheck.Key).toEqual({ pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1', sk: 'METADATA' });
    expect(occupancyCheck.ConditionExpression).toBe('attribute_exists(pk)');

    const domainUpdate = transactItems[2]?.Update as {
      Key: Record<string, unknown>;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(domainUpdate.Key).toEqual({
      pk: 'DEPT#NICHOLS#OCCUPANCY#OCC-1',
      sk: 'INSPECTION#INS-1',
    });
    expect(domainUpdate.ConditionExpression).toBe('attribute_exists(sk)');
    expect(domainUpdate.ExpressionAttributeValues[':photoS3Keys']).toEqual([
      'NICHOLS/INSPECTION_RECORD/INS-1/photo.jpg',
    ]);
    expect(domainUpdate.ExpressionAttributeValues[':conductedBy']).toBe('member-1');
  });

  it('throws FieldCaptureInspectionNotFoundError when no inspection record exists to attach to (ticket depends-on E5-S5)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: undefined });
    await expect(submitFieldCapture(fakeDoc(send), TABLE, buildInput())).rejects.toThrow(
      FieldCaptureInspectionNotFoundError,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses a client-supplied conductedAt for conductedDate instead of the server clock, when provided', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: EXISTING_ITEM }).mockResolvedValueOnce({});
    const result = await submitFieldCapture(
      fakeDoc(send),
      TABLE,
      buildInput({ conductedAt: '2026-09-10T12:00:00.000Z' }),
    );
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.item.conductedDate).toBe('2026-09-10T12:00:00.000Z');
    }
  });

  it('returns a duplicate outcome carrying the previously-written item and writes nothing new on a retried idempotencyKey, without throwing (AC2 core-harm)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: EXISTING_ITEM })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        }),
      );
    const result = await submitFieldCapture(fakeDoc(send), TABLE, buildInput());
    expect(result).toEqual({ outcome: 'duplicate', item: EXISTING_ITEM });
  });

  it('throws FieldCaptureOccupancyNotFoundError when the occupancy no longer exists', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: EXISTING_ITEM })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        }),
      );
    await expect(submitFieldCapture(fakeDoc(send), TABLE, buildInput())).rejects.toThrow(
      FieldCaptureOccupancyNotFoundError,
    );
  });

  it('throws FieldCaptureInspectionNotFoundError when the domain item vanished between the lookup and the write', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: EXISTING_ITEM })
      .mockRejectedValueOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        }),
      );
    await expect(submitFieldCapture(fakeDoc(send), TABLE, buildInput())).rejects.toThrow(
      FieldCaptureInspectionNotFoundError,
    );
  });

  it('wraps a DynamoDB unavailable/throttled failure in FieldCaptureDependencyError (503)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: EXISTING_ITEM })
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(submitFieldCapture(fakeDoc(send), TABLE, buildInput())).rejects.toThrow(
      FieldCaptureDependencyError,
    );
  });

  it('wraps a lookup failure in FieldCaptureDependencyError', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(submitFieldCapture(fakeDoc(send), TABLE, buildInput())).rejects.toThrow(
      FieldCaptureDependencyError,
    );
  });
});
