import { describe, expect, it, vi } from 'vitest';
import { DynamoDBServiceException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  ConflictError,
  getDepartmentConfig,
  putDepartmentConfig,
  type DepartmentConfigItem,
} from './repository.js';

function mockDocClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

interface PutItemLike {
  readonly Put?:
    | {
        readonly TableName?: string | undefined;
        readonly Item?: Record<string, unknown> | undefined;
        readonly ConditionExpression?: string | undefined;
        readonly ExpressionAttributeValues?: Record<string, unknown> | undefined;
      }
    | undefined;
}

function transactItems(send: ReturnType<typeof vi.fn>): readonly PutItemLike[] {
  const call = send.mock.calls.find((c) => c[0] instanceof TransactWriteCommand)?.[0] as
    TransactWriteCommand | undefined;
  return call?.input.TransactItems ?? [];
}

describe('department config repository', () => {
  const deptId = toVerifiedDeptId({ deptId: 'nichols' });

  it('getDepartmentConfig returns undefined when the item is missing', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await getDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'ALERT_RULES',
    });
    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('getDepartmentConfig returns the stored item', async () => {
    const item: DepartmentConfigItem = {
      pk: 'DEPT#nichols',
      sk: 'CONFIG#ALERT_RULES',
      entityType: 'DEPARTMENT_CONFIG',
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 3 },
      version: 4,
      updatedAt: '2026-09-15T00:00:00.000Z',
      updatedBy: 'member-1',
    };
    const send = vi.fn().mockResolvedValue({ Item: item });
    const result = await getDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'ALERT_RULES',
    });
    expect(result).toEqual(item);
  });

  it('putDepartmentConfig creates version 1 when no prior version is supplied', async () => {
    const send = vi.fn().mockResolvedValue({});
    const saved = await putDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'CHECKLIST_DEFAULTS',
      value: { items: [{ code: 'FUEL', label: 'Fuel level', requiresPhoto: false }] },
      actorId: 'admin-1',
      correlationId: 'trace-1',
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });
    expect(saved.version).toBe(1);
    expect(saved.sk).toBe('CONFIG#CHECKLIST_DEFAULTS');
    expect(saved.entityType).toBe('DEPARTMENT_CONFIG');

    const items = transactItems(send);
    expect(items).toHaveLength(2);
    const configPut = items[0]?.Put;
    expect(configPut?.ConditionExpression).toContain('attribute_not_exists(pk)');
    expect(configPut?.Item).toMatchObject({ version: 1, configType: 'CHECKLIST_DEFAULTS' });
  });

  it('putDepartmentConfig increments version with an optimistic lock on the prior version', async () => {
    const send = vi.fn().mockResolvedValue({});
    const saved = await putDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 5 },
      actorId: 'admin-1',
      correlationId: 'trace-2',
      expectedVersion: 4,
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });
    expect(saved.version).toBe(5);

    const items = transactItems(send);
    const configPut = items[0]?.Put;
    expect(configPut?.Item?.version).toBe(5);
    expect(configPut?.ConditionExpression).toContain('#version = :expectedVersion');
    expect(configPut?.ExpressionAttributeValues?.[':expectedVersion']).toBe(4);
  });

  it('putDepartmentConfig writes an outbox record in the same transaction (E8-S4 review round 2, PR #145)', async () => {
    const send = vi.fn().mockResolvedValue({});
    await putDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'RETENTION',
      value: { retentionYears: 10 },
      actorId: 'admin-1',
      correlationId: 'trace-3',
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });

    const items = transactItems(send);
    expect(items).toHaveLength(2);
    const outboxItem = items[1]?.Put?.Item;
    expect(outboxItem).toMatchObject({
      entityType: 'OUTBOX_ENTRY',
      eventType: 'platform.config.updated',
      source: 'platform-service',
      correlationId: 'trace-3',
      pk: 'DEPT#nichols#OUTBOX',
      payload: {
        configType: 'RETENTION',
        version: 1,
        value: { retentionYears: 10 },
        updatedBy: 'admin-1',
        deptId,
      },
    });
  });

  it('putDepartmentConfig maps a ConditionalCheckFailed transaction cancellation to ConflictError', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'conflict',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(
      putDepartmentConfig(mockDocClient(send), {
        tableName: 'platform',
        deptId,
        configType: 'ALERT_RULES',
        value: { escalationThresholdN: 5 },
        actorId: 'admin-1',
        correlationId: 'trace-4',
        expectedVersion: 4,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('putDepartmentConfig rethrows unexpected DynamoDB errors', async () => {
    const send = vi.fn().mockRejectedValue(
      new DynamoDBServiceException({
        name: 'InternalServerError',
        $fault: 'server',
        $metadata: {},
        message: 'boom',
      }),
    );
    await expect(
      putDepartmentConfig(mockDocClient(send), {
        tableName: 'platform',
        deptId,
        configType: 'STATIONS',
        value: { stations: [] },
        actorId: 'admin-1',
        correlationId: 'trace-5',
      }),
    ).rejects.toBeInstanceOf(DynamoDBServiceException);
  });
});
