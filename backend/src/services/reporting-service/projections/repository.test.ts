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

  it('guards each rollup write with a per-field clock taken from the event time', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    await applyProjection(
      client,
      'platform',
      deptId,
      { ...event, eventTimeMs: 1_600_000_000_000 },
      1_700_000_000_000,
    );
    const items = (
      send.mock.calls[0]?.[0] as unknown as {
        input: { TransactItems: { Update?: Record<string, unknown> }[] };
      }
    ).input.TransactItems;
    expect(items[1]?.Update).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#clock) OR #clock <= :clockMs',
      ExpressionAttributeNames: {
        '#clock': 'statusAt',
        '#entityType': 'entityType',
        '#memberId': 'memberId',
        '#status': 'status',
        '#removed': 'removed',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':clockMs': 1_600_000_000_000,
        ':entityType': 'REPORTING_MEMBER',
        ':memberId': 'm-1',
        ':status': 'ACTIVE',
      },
    });
    expect(items[2]?.Update).not.toHaveProperty('ConditionExpression');
  });

  it('reports a rollup write that loses the clock comparison as stale instead of failing', async () => {
    const error = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValue(error);
    const client = { send } as unknown as DynamoDBDocumentClient;
    await expect(applyProjection(client, 'platform', deptId, event, 1)).resolves.toBe('stale');
  });

  it('turns a delete into a clock-guarded tombstone with a ttl', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as DynamoDBDocumentClient;
    await applyProjection(
      client,
      'platform',
      deptId,
      {
        eventId: 'evt-2',
        eventType: 'neris.incident.approved',
        deptId: 'NICHOLS',
        eventTimeMs: 1_650_000_000_000,
        payload: { incidentId: 'inc-1' },
      },
      1_700_000_000_000,
    );
    const items = (
      send.mock.calls[0]?.[0] as unknown as {
        input: { TransactItems: Record<string, unknown>[] };
      }
    ).input.TransactItems;
    expect(items.some((item) => 'Delete' in item)).toBe(false);
    expect(items[1]?.Update).toMatchObject({
      Key: { pk: 'DEPT#NICHOLS#REPORTING_ROLLUP', sk: 'NERIS#inc-1' },
      ConditionExpression: 'attribute_not_exists(#clock) OR #clock <= :clockMs',
      ExpressionAttributeValues: {
        ':removed': true,
        ':ttl': 1_700_000_000 + 48 * 60 * 60,
        ':clockMs': 1_650_000_000_000,
      },
    });
  });
});
