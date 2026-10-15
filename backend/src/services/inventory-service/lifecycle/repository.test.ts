import { describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DEFAULT_LIFECYCLE_STATUS,
  LIFECYCLE_TRANSITIONS,
  LifecycleTransitionConflictError,
  getEquipmentAsset,
  isAssignmentEligible,
  readInventoryConfig,
  transitionLifecycleStatus,
  type LifecycleStatus,
} from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'dept-001' });

function fakeClient(
  send: (command: { input: unknown }) => Promise<unknown>,
): DynamoDBDocumentClient {
  return { send: vi.fn(send) } as unknown as DynamoDBDocumentClient;
}

describe('readInventoryConfig', () => {
  it('throws a descriptive error when PLATFORM_TABLE_NAME is not set', () => {
    expect(() => readInventoryConfig({})).toThrow(/PLATFORM_TABLE_NAME/);
  });

  it('returns the table name when set', () => {
    expect(readInventoryConfig({ PLATFORM_TABLE_NAME: 'platform' })).toEqual({
      tableName: 'platform',
    });
  });
});

describe('DEFAULT_LIFECYCLE_STATUS (AC1)', () => {
  it('defaults to ACQUIRED so a newly registered asset starts acquired', () => {
    expect(DEFAULT_LIFECYCLE_STATUS).toBe('ACQUIRED');
  });
});

describe('LIFECYCLE_TRANSITIONS', () => {
  it('allows ACQUIRED to move to IN_SERVICE or RETIRED (AC2)', () => {
    expect(LIFECYCLE_TRANSITIONS.ACQUIRED).toEqual(['IN_SERVICE', 'RETIRED']);
  });

  it('allows IN_SERVICE to move only to RETIRED, never back to ACQUIRED', () => {
    expect(LIFECYCLE_TRANSITIONS.IN_SERVICE).toEqual(['RETIRED']);
  });

  it('treats RETIRED as terminal — no further transitions (AC2)', () => {
    expect(LIFECYCLE_TRANSITIONS.RETIRED).toEqual([]);
  });
});

describe('getEquipmentAsset', () => {
  it('reads the item via a dept-scoped pk and METADATA sk', async () => {
    const client = fakeClient(() => Promise.resolve({ Item: { lifecycleStatus: 'IN_SERVICE' } }));

    const asset = await getEquipmentAsset(client, { tableName: 'platform' }, DEPT_ID, 'AS-0055');

    expect(asset).toEqual({ assetId: 'AS-0055', lifecycleStatus: 'IN_SERVICE' });
    const sentCommand = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: { Key: { pk: string; sk: string } };
    };
    expect(sentCommand.input.Key).toEqual({ pk: 'DEPT#dept-001#ASSET#AS-0055', sk: 'METADATA' });
  });

  it('returns undefined when no item exists (404 path)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    const asset = await getEquipmentAsset(client, { tableName: 'platform' }, DEPT_ID, 'AS-missing');

    expect(asset).toBeUndefined();
  });

  it('defaults to DEFAULT_LIFECYCLE_STATUS when the item exists but carries no lifecycleStatus (AC1)', async () => {
    const client = fakeClient(() => Promise.resolve({ Item: { assetId: 'AS-0099' } }));

    const asset = await getEquipmentAsset(client, { tableName: 'platform' }, DEPT_ID, 'AS-0099');

    expect(asset).toEqual({ assetId: 'AS-0099', lifecycleStatus: DEFAULT_LIFECYCLE_STATUS });
  });
});

type TransactInput = {
  TransactItems: {
    Update?: {
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, string>;
      UpdateExpression: string;
    };
    Put?: { Item: Record<string, unknown>; ConditionExpression: string };
  }[];
};

function sentTransaction(client: DynamoDBDocumentClient): TransactInput {
  return ((client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { input: TransactInput })
    .input;
}

function transition(client: DynamoDBDocumentClient, from: LifecycleStatus, to: LifecycleStatus) {
  return transitionLifecycleStatus(
    client,
    { tableName: 'platform' },
    DEPT_ID,
    'admin-1',
    'AS-0055',
    from,
    to,
  );
}

describe('transitionLifecycleStatus', () => {
  it('conditionally updates lifecycleStatus and returns the new state (AC2)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    const updated = await transition(client, 'ACQUIRED', 'IN_SERVICE');

    expect(updated).toEqual({ assetId: 'AS-0055', lifecycleStatus: 'IN_SERVICE' });
    const update = sentTransaction(client).TransactItems[0]?.Update;
    expect(update?.ConditionExpression).toContain('lifecycleStatus = :from');
    expect(update?.ExpressionAttributeValues).toEqual({ ':to': 'IN_SERVICE', ':from': 'ACQUIRED' });
    expect(update?.UpdateExpression).toBe('SET lifecycleStatus = :to');
  });

  it('removes gsi1pk/gsi1sk on transition to RETIRED so the asset drops out of the assignment-eligible GSI1 projection (AC2, core-harm)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    await transition(client, 'IN_SERVICE', 'RETIRED');

    expect(sentTransaction(client).TransactItems[0]?.Update?.UpdateExpression).toBe(
      'SET lifecycleStatus = :to REMOVE gsi1pk, gsi1sk',
    );
  });

  it('writes an AUDIT_LOG_ENTRY with actor and old/new status in the same transaction (F9.4)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    await transition(client, 'IN_SERVICE', 'RETIRED');

    const audit = sentTransaction(client).TransactItems[1]?.Put;
    expect(audit?.Item).toMatchObject({
      entityType: 'AUDIT_LOG_ENTRY',
      mutatedEntityType: 'EQUIPMENT_ASSET',
      mutatedEntityId: 'AS-0055',
      action: 'UPDATE',
      actorId: 'admin-1',
      changedFields: { lifecycleStatus: { old: 'IN_SERVICE', new: 'RETIRED' } },
      gsi3pk: 'DEPT#dept-001#AUDIT#ENTITY#EQUIPMENT_ASSET#AS-0055',
    });
    expect(audit?.Item.pk).toMatch(/^DEPT#dept-001#AUDIT#\d{4}-\d{2}-\d{2}$/);
    expect(audit?.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
  });

  it('throws LifecycleTransitionConflictError, not the raw SDK error, when the status condition loses a race', async () => {
    const client = fakeClient(() => {
      throw new TransactionCanceledException({
        message: 'canceled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      });
    });

    await expect(transition(client, 'IN_SERVICE', 'RETIRED')).rejects.toThrow(
      LifecycleTransitionConflictError,
    );
  });

  it('does not report an audit-row collision as a lifecycle conflict', async () => {
    const client = fakeClient(() => {
      throw new TransactionCanceledException({
        message: 'canceled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      });
    });

    await expect(transition(client, 'IN_SERVICE', 'RETIRED')).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
  });

  it('propagates a DynamoDB outage rather than silently no-opping the transition (core-harm, fail-closed)', async () => {
    const client = fakeClient(() => {
      throw new Error('ProvisionedThroughputExceededException');
    });

    await expect(transition(client, 'IN_SERVICE', 'RETIRED')).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});

describe('isAssignmentEligible (AC2, core-harm)', () => {
  it('is false for RETIRED so a retired asset no longer appears in active assignment-eligible lists', () => {
    expect(isAssignmentEligible('RETIRED')).toBe(false);
  });

  it('is true for ACQUIRED and IN_SERVICE', () => {
    expect(isAssignmentEligible('ACQUIRED')).toBe(true);
    expect(isAssignmentEligible('IN_SERVICE')).toBe(true);
  });
});
