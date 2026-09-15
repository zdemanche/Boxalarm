import { describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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

interface PutCommandLike {
  readonly input: {
    readonly ConditionExpression?: string;
    readonly Item?: { readonly version?: number };
    readonly ExpressionAttributeValues?: Record<string, unknown>;
  };
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
      value: { items: ['fuel'] },
      actorId: 'admin-1',
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });
    expect(saved.version).toBe(1);
    expect(saved.sk).toBe('CONFIG#CHECKLIST_DEFAULTS');
    expect(saved.entityType).toBe('DEPARTMENT_CONFIG');
    const createCmd = send.mock.calls[0]?.[0] as PutCommandLike;
    expect(createCmd.input.ConditionExpression).toContain('attribute_not_exists(pk)');
  });

  it('putDepartmentConfig increments version with an optimistic lock on the prior version', async () => {
    const send = vi.fn().mockResolvedValue({});
    const saved = await putDepartmentConfig(mockDocClient(send), {
      tableName: 'platform',
      deptId,
      configType: 'ALERT_RULES',
      value: { escalationThresholdN: 5 },
      actorId: 'admin-1',
      expectedVersion: 4,
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });
    expect(saved.version).toBe(5);
    const input = (send.mock.calls[0]?.[0] as PutCommandLike).input;
    expect(input.Item?.version).toBe(5);
    expect(input.ConditionExpression).toContain('#version = :expectedVersion');
    expect(input.ExpressionAttributeValues?.[':expectedVersion']).toBe(4);
  });

  it('putDepartmentConfig maps ConditionalCheckFailedException to ConflictError', async () => {
    const send = vi.fn().mockRejectedValue(
      new ConditionalCheckFailedException({
        message: 'conflict',
        $metadata: {},
      }),
    );
    await expect(
      putDepartmentConfig(mockDocClient(send), {
        tableName: 'platform',
        deptId,
        configType: 'ALERT_RULES',
        value: { escalationThresholdN: 5 },
        actorId: 'admin-1',
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
      }),
    ).rejects.toBeInstanceOf(DynamoDBServiceException);
  });
});
