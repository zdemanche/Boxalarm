import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getSelfTestRun, upsertSelfTestRun } from './selfTestRunRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

describe('upsertSelfTestRun', () => {
  it('writes a SELF_TEST_RUN item keyed distinctly from DISPATCH_ALERT/DELIVERY_RECEIPT (AC3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    await upsertSelfTestRun({ send } as unknown as DynamoDBDocumentClient, 'alerting-table', {
      deptId: DEPT_ID,
      memberId: 'mbr-1',
      testId: '1798000000',
      runAt: 1798000000,
      channelsTested: ['PUSH', 'SMS'],
      channelResults: { PUSH: { ok: true, ms: 42 }, SMS: { ok: true, ms: 50 } },
      overallResult: 'PASS',
    });

    const call = send.mock.calls[0]?.[0] as { input: { Item: Record<string, unknown> } };
    const item = call.input.Item;
    expect(item.pk).toBe('DEPT#NICHOLS#MEMBER#mbr-1');
    expect(item.sk).toBe('SELFTEST#1798000000');
    expect(item.entityType).toBe('SELF_TEST_RUN');
    expect(item.ttl).toBe(1798000000 + 60 * 60 * 24 * 365);
    expect(item.overallResult).toBe('PASS');
  });
});

describe('getSelfTestRun', () => {
  it('reads back the item written for a matching deptId/memberId/testId', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { testId: '1798000000', overallResult: 'PASS' } });
    const item = await getSelfTestRun(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
      'mbr-1',
      '1798000000',
    );
    expect(item?.testId).toBe('1798000000');
    const call = send.mock.calls[0]?.[0] as { input: { Key: Record<string, unknown> } };
    expect(call.input.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#mbr-1', sk: 'SELFTEST#1798000000' });
  });

  it('returns undefined when no run exists for that testId', async () => {
    const send = vi.fn().mockResolvedValue({});
    const item = await getSelfTestRun(
      { send } as unknown as DynamoDBDocumentClient,
      'alerting-table',
      DEPT_ID,
      'mbr-1',
      'unknown',
    );
    expect(item).toBeUndefined();
  });
});
