import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildLosapEntryItem,
  getMemberLosapTotal,
  LosapRepositoryUnavailableError,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-service';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('buildLosapEntryItem', () => {
  it('builds the LOSAP_POINT_ENTRY item per the architecture entity shape', () => {
    const item = buildLosapEntryItem({
      deptId: DEPT_ID,
      memberId: 'mbr-102',
      year: 2026,
      activityType: 'CALL',
      points: 2,
      sourceRefId: 'ATTENDANCE#1798000500',
      ruleVersionId: 'RULE-2026',
      entryId: 'LP-0812',
    });

    expect(item).toEqual({
      pk: 'DEPT#NICHOLS#MEMBER#mbr-102',
      sk: 'LOSAP#2026#LP-0812',
      entityType: 'LOSAP_POINT_ENTRY',
      year: 2026,
      activityType: 'CALL',
      points: 2,
      sourceRefId: 'ATTENDANCE#1798000500',
      ruleVersionId: 'RULE-2026',
      gsi1pk: 'MEMBER#mbr-102',
      gsi1sk: 'LOSAP_POINT_ENTRY#2026',
    });
  });
});

describe('getMemberLosapTotal', () => {
  it('sums points across every LOSAP_POINT_ENTRY item for the member and year (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ points: 2 }, { points: 3 }] });
    const total = await getMemberLosapTotal(fakeClient(send), TABLE, DEPT_ID, 'mbr-102', 2026);

    expect(total).toBe(5);
    const call = send.mock.calls[0]?.[0] as {
      input: { KeyConditionExpression: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(call.input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :skPrefix)');
    expect(call.input.ExpressionAttributeValues[':pk']).toBe('DEPT#NICHOLS#MEMBER#mbr-102');
    expect(call.input.ExpressionAttributeValues[':skPrefix']).toBe('LOSAP#2026#');
  });

  it('returns 0 when no entries exist yet', async () => {
    const send = vi.fn().mockResolvedValue({});
    const total = await getMemberLosapTotal(fakeClient(send), TABLE, DEPT_ID, 'mbr-102', 2026);
    expect(total).toBe(0);
  });

  it('scopes the query to the caller dept + member main-table partition, not the shared GSI1 key (P4)', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const otherDept = toVerifiedDeptId({ deptId: 'OTHERFD' });
    await getMemberLosapTotal(fakeClient(send), TABLE, otherDept, 'mbr-102', 2026);

    const call = send.mock.calls[0]?.[0] as {
      input: { IndexName?: string; ExpressionAttributeValues: Record<string, string> };
    };
    expect(call.input.IndexName).toBeUndefined();
    expect(call.input.ExpressionAttributeValues[':pk']).toBe('DEPT#OTHERFD#MEMBER#mbr-102');
  });

  it('follows LastEvaluatedKey to fetch every page of entries (P3)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ points: 2 }], LastEvaluatedKey: { pk: 'a', sk: 'b' } })
      .mockResolvedValueOnce({ Items: [{ points: 5 }] });

    const total = await getMemberLosapTotal(fakeClient(send), TABLE, DEPT_ID, 'mbr-102', 2026);

    expect(total).toBe(7);
    expect(send).toHaveBeenCalledTimes(2);
    const secondCall = send.mock.calls[1]?.[0] as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(secondCall.input.ExclusiveStartKey).toEqual({ pk: 'a', sk: 'b' });
  });

  it('wraps a DynamoDB failure in LosapRepositoryUnavailableError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(
      getMemberLosapTotal(fakeClient(send), TABLE, DEPT_ID, 'mbr-102', 2026),
    ).rejects.toThrow(LosapRepositoryUnavailableError);
  });
});
