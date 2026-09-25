import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  CutoverDecisionRepositoryUnavailableError,
  getCutoverDecision,
  recordCutoverDecision,
} from './repository.js';

const send = vi.fn();
const client = { send } as never;
const deptId = 'NICHOLS' as VerifiedDeptId;
const tableName = 'platform-table';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCutoverDecision', () => {
  it('returns undefined when no CURRENT item exists', async () => {
    send.mockResolvedValue({ Item: undefined });
    const result = await getCutoverDecision(client, tableName, deptId);
    expect(result).toBeUndefined();
  });

  it('maps the CURRENT item to a CutoverDecisionRecord', async () => {
    send.mockResolvedValue({
      Item: { decision: 'accept', decider: 'member-0001', decidedAt: 1700000000000 },
    });
    const result = await getCutoverDecision(client, tableName, deptId);
    expect(result).toEqual({ decision: 'accept', decider: 'member-0001', decidedAt: 1700000000000 });
  });

  it('reads by the dept-scoped CUTOVER_DECISION pk and CURRENT sk', async () => {
    send.mockResolvedValue({ Item: undefined });
    await getCutoverDecision(client, tableName, deptId);
    const [command] = send.mock.calls[0] as [{ input: { Key: { pk: string; sk: string } } }];
    expect(command.input.Key).toEqual({ pk: 'DEPT#NICHOLS#CUTOVER_DECISION', sk: 'CURRENT' });
  });

  it('wraps a DynamoDB failure in CutoverDecisionRepositoryUnavailableError', async () => {
    send.mockRejectedValue(new Error('table unavailable'));
    await expect(getCutoverDecision(client, tableName, deptId)).rejects.toBeInstanceOf(
      CutoverDecisionRepositoryUnavailableError,
    );
  });
});

describe('recordCutoverDecision', () => {
  const record = { decision: 'accept' as const, decider: 'member-0001', decidedAt: 1700000000000 };

  it('writes the CURRENT snapshot and an append-only DECISION history item in one transact-write', async () => {
    send.mockResolvedValue({});
    await recordCutoverDecision(client, tableName, deptId, record);
    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: { Put: { Item: { sk: string }; ConditionExpression?: string } }[] } },
    ];
    const items = command.input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0]?.Put.Item.sk).toBe('CURRENT');
    expect(items[0]?.Put.ConditionExpression).toBeUndefined();
    expect(items[1]?.Put.Item.sk).toBe('DECISION#1700000000000');
    expect(items[1]?.Put.ConditionExpression).toBe('attribute_not_exists(sk)');
  });

  it('scopes both items to the dept-scoped CUTOVER_DECISION pk', async () => {
    send.mockResolvedValue({});
    await recordCutoverDecision(client, tableName, deptId, record);
    const [command] = send.mock.calls[0] as [
      { input: { TransactItems: { Put: { Item: { pk: string } } }[] } },
    ];
    for (const item of command.input.TransactItems) {
      expect(item.Put.Item.pk).toBe('DEPT#NICHOLS#CUTOVER_DECISION');
    }
  });

  it('wraps a transact-write conflict in CutoverDecisionRepositoryUnavailableError', async () => {
    const cancelled = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    send.mockRejectedValue(cancelled);
    await expect(recordCutoverDecision(client, tableName, deptId, record)).rejects.toBeInstanceOf(
      CutoverDecisionRepositoryUnavailableError,
    );
  });
});
