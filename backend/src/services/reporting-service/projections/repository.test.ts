import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { describe, expect, it, vi } from 'vitest';
import { PROJECTION_CONSUMER_NAME } from './constants.js';
import type { DomainEvent } from './events.js';
import { applyProjection } from './repository.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const event: DomainEvent = {
  eventId: 'evt-1',
  eventType: 'personnel.member.updated',
  deptId: 'NICHOLS',
  payload: { memberId: 'm-1', newStatus: 'ACTIVE' },
};

describe('applyProjection', () => {
  it('conditionally puts a department-scoped dedup item and upserts the rollup', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    const result = await applyProjection(client, 'platform', deptId, event, 1_700_000_000_000);
    expect(result).toBe('applied');
    const invocation = send.mock.calls[0]?.[0] as unknown as {
      input: {
        TransactItems: {
          Put?: { Item: Record<string, unknown>; ConditionExpression?: string };
        }[];
      };
    };
    const dedup = invocation.input.TransactItems[0]?.Put;
    expect(dedup?.Item.pk).toBe(`DEPT#NICHOLS#DEDUP#${PROJECTION_CONSUMER_NAME}`);
    expect(dedup?.Item.sk).toBe('EVT#evt-1');
    expect(dedup?.ConditionExpression).toBe('attribute_not_exists(sk)');
    expect(dedup?.Item.ttl).toBe(1_700_000_000 + 48 * 60 * 60);
    expect(JSON.stringify(invocation.input)).not.toContain('alerting');
  });

  it('treats a conditional dedup collision as an already-applied duplicate', async () => {
    const error = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValue(error);
    const client = { send } as unknown as DynamoDBDocumentClient;
    await expect(applyProjection(client, 'platform', deptId, event, 1)).resolves.toBe('duplicate');
  });
});
