import { describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  getMemberEligibility,
  parseSnapshotItem,
  queryEligibleMembers,
  queryEligiblePartition,
} from './selector.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function snapshotItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'DEPT#NICHOLS#ELIGIBILITY',
    sk: 'MEMBER#mbr-1',
    entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT',
    memberId: 'mbr-1',
    active: true,
    quals: ['INTERIOR'],
    roles: ['MEMBER'],
    availabilityState: 'AVAILABLE',
    snapshotUpdatedAt: 1000,
    ...overrides,
  };
}

describe('parseSnapshotItem', () => {
  it('returns undefined for an absent item', () => {
    expect(parseSnapshotItem(undefined)).toBeUndefined();
  });

  it('throws on a malformed item', () => {
    expect(() => parseSnapshotItem({ pk: 'x' })).toThrow(
      'MEMBER_ELIGIBILITY_SNAPSHOT item failed shape validation',
    );
  });
});

describe('queryEligibleMembers (core-harm: a marked-off member must never be returned)', () => {
  it('excludes a member with availabilityState=MARKED_OFF (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [snapshotItem(), snapshotItem({ memberId: 'mbr-2', availabilityState: 'MARKED_OFF' })],
    });
    const result = await queryEligibleMembers(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(result.map((m) => m.memberId)).toEqual(['mbr-1']);
  });

  it('includes every member the query returns whose availabilityState is AVAILABLE, regardless of snapshotUpdatedAt recency (window not-yet-started and post-revert both surface here as AVAILABLE — the real window transitions are proven end to end in chain.test.ts)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        snapshotItem({ memberId: 'mbr-2', availabilityState: 'AVAILABLE', snapshotUpdatedAt: 500 }),
        snapshotItem({
          memberId: 'mbr-3',
          availabilityState: 'AVAILABLE',
          snapshotUpdatedAt: 2000,
        }),
      ],
    });
    const result = await queryEligibleMembers(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(result.map((m) => m.memberId).sort()).toEqual(['mbr-2', 'mbr-3']);
  });

  it('excludes an inactive member', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [snapshotItem({ active: false })] });
    const result = await queryEligibleMembers(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(result).toEqual([]);
  });

  it('logs and skips a single malformed item instead of failing the whole partition query (R2)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [snapshotItem(), { pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-broken' }],
    });
    const result = await queryEligiblePartition(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    expect(result.map((m) => m.memberId)).toEqual(['mbr-1']);
  });

  it('queries only this department scoped ELIGIBILITY partition', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await queryEligibleMembers(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
    );
    const call = send.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(call.input.ExpressionAttributeValues[':pk']).toBe('DEPT#NICHOLS#ELIGIBILITY');
  });
});

describe('getMemberEligibility (self-test single-member lookup, E1-S8 AC1)', () => {
  it('returns the snapshot for a found member via a single GetCommand keyed on MEMBER#{memberId}', async () => {
    const send = vi.fn().mockResolvedValue({ Item: snapshotItem() });
    const result = await getMemberEligibility(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
      'mbr-1',
    );
    expect(result?.memberId).toBe('mbr-1');
    const call = send.mock.calls[0]?.[0] as { input: { Key: Record<string, string> } };
    expect(call.input.Key).toEqual({ pk: 'DEPT#NICHOLS#ELIGIBILITY', sk: 'MEMBER#mbr-1' });
  });

  it('returns undefined when the member has no MEMBER_ELIGIBILITY_SNAPSHOT item', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    const result = await getMemberEligibility(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
      'mbr-missing',
    );
    expect(result).toBeUndefined();
  });

  it("still returns a member marked off — self-test exercises the caller's own path regardless of roster availability state", async () => {
    const send = vi.fn().mockResolvedValue({
      Item: snapshotItem({ availabilityState: 'MARKED_OFF' }),
    });
    const result = await getMemberEligibility(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
      'mbr-1',
    );
    expect(result?.availabilityState).toBe('MARKED_OFF');
  });
});
