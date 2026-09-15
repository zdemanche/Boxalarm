import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { PrePlanCopyDependencyError, getPrePlanCopy } from './prePlanCopyRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'alerting-table';

function fakeDoc(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('getPrePlanCopy', () => {
  it('resolves via a single Query on the department PREPLAN partition (AC1, AC3)', async () => {
    const item = {
      summary: 'Two-story residential, propane tank rear',
      hazards: ['LPG_TANK_REAR'],
      utilityShutoffs: [{ utility: 'GAS', location: 'rear of building' }],
      nearestHydrants: [{ id: 'HYD-1', location: 'corner', size: '6in', flow: '1000gpm' }],
      snapshotUpdatedAt: 1798000000,
    };
    const send = vi.fn().mockResolvedValue({ Items: [item] });
    const result = await getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toEqual(item);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#NICHOLS#PREPLAN',
      ':sk': 'OCCUPANCY#OCC-1',
    });
  });

  it('returns undefined when no PRE_PLAN_COPY exists for the occupancy (AC2)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const result = await getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1');
    expect(result).toBeUndefined();
  });

  it('wraps a DynamoDB failure in PrePlanCopyDependencyError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    await expect(getPrePlanCopy(fakeDoc(send), TABLE, DEPT_ID, 'OCC-1')).rejects.toThrow(
      PrePlanCopyDependencyError,
    );
  });
});
