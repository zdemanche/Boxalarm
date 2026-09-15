import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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

describe('transitionLifecycleStatus', () => {
  it('conditionally updates lifecycleStatus and returns the new state (AC2)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    const updated = await transitionLifecycleStatus(
      client,
      { tableName: 'platform' },
      DEPT_ID,
      'AS-0055',
      'ACQUIRED',
      'IN_SERVICE',
    );

    expect(updated).toEqual({ assetId: 'AS-0055', lifecycleStatus: 'IN_SERVICE' });
    const sentCommand = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: {
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, string>;
        UpdateExpression: string;
      };
    };
    expect(sentCommand.input.ConditionExpression).toContain('lifecycleStatus = :from');
    expect(sentCommand.input.ExpressionAttributeValues).toEqual({
      ':to': 'IN_SERVICE',
      ':from': 'ACQUIRED',
    });
    expect(sentCommand.input.UpdateExpression).toBe('SET lifecycleStatus = :to');
  });

  it('removes gsi1pk/gsi1sk on transition to RETIRED so the asset drops out of the assignment-eligible GSI1 projection (AC2, core-harm)', async () => {
    const client = fakeClient(() => Promise.resolve({}));

    await transitionLifecycleStatus(
      client,
      { tableName: 'platform' },
      DEPT_ID,
      'AS-0055',
      'IN_SERVICE',
      'RETIRED',
    );

    const sentCommand = (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      input: { UpdateExpression: string };
    };
    expect(sentCommand.input.UpdateExpression).toBe(
      'SET lifecycleStatus = :to REMOVE gsi1pk, gsi1sk',
    );
  });

  it('throws LifecycleTransitionConflictError, not the raw SDK error, when the conditional update loses a race', async () => {
    const client = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} });
    });

    await expect(
      transitionLifecycleStatus(
        client,
        { tableName: 'platform' },
        DEPT_ID,
        'AS-0055',
        'IN_SERVICE',
        'RETIRED',
      ),
    ).rejects.toThrow(LifecycleTransitionConflictError);
  });

  it('propagates a DynamoDB outage rather than silently no-opping the transition (core-harm, fail-closed)', async () => {
    const client = fakeClient(() => {
      throw new Error('ProvisionedThroughputExceededException');
    });

    await expect(
      transitionLifecycleStatus(
        client,
        { tableName: 'platform' },
        DEPT_ID,
        'AS-0055',
        'IN_SERVICE',
        'RETIRED',
      ),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
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
