import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  RetentionConfigConflictError,
  getRetentionConfig,
  putRetentionConfig,
} from './configRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

function fakeDocClient(sendImpl: (command: unknown) => unknown) {
  return { send: vi.fn(sendImpl) } as never;
}

describe('retention configRepository', () => {
  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
  });

  it('puts DEPARTMENT_CONFIG at pk=DEPT#{deptId} sk=CONFIG#RETENTION (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeDocClient(send);

    const result = await putRetentionConfig(client, {
      deptId: DEPT_ID,
      retentionYears: 10,
      actorId: 'MBR-0001',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    const command = send.mock.calls[1]?.[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toMatchObject({
      TableName: 'platform-service',
      Item: {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears: 10 },
        version: 1,
      },
      ConditionExpression: 'attribute_not_exists(pk) OR version = :expectedVersion',
    });
    expect(result).toMatchObject({
      configType: 'RETENTION',
      value: { retentionYears: 10 },
      version: 1,
    });
  });

  it('gets stored retention config and uses it (not a hardcoded constant)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS',
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears: 5 },
        version: 3,
      },
    });
    const client = fakeDocClient(send);

    const result = await getRetentionConfig(client, DEPT_ID);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: 'platform-service',
      Key: { pk: buildDeptScopedPk(DEPT_ID), sk: 'CONFIG#RETENTION' },
    });
    expect(result.retentionYears).toBe(5);
    expect(result.version).toBe(3);
    expect(result.source).toBe('stored');
  });

  it('falls back to default 7 years when config is missing (N6.3)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeDocClient(send);

    const result = await getRetentionConfig(client, DEPT_ID);

    expect(result.retentionYears).toBe(7);
    expect(result.source).toBe('default');
  });

  it('increments version on overwrite when an existing config is present', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS',
          sk: 'CONFIG#RETENTION',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'RETENTION',
          value: { retentionYears: 7 },
          version: 2,
        },
      })
      .mockResolvedValueOnce({});
    const client = fakeDocClient(send);

    const result = await putRetentionConfig(client, {
      deptId: DEPT_ID,
      retentionYears: 12,
      actorId: 'MBR-0001',
    });

    expect(result.version).toBe(3);
    const put = send.mock.calls[1]?.[0] as PutCommand;
    expect(put.input.Item?.version).toBe(3);
    expect(put.input.Item?.value).toEqual({ retentionYears: 12 });
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR version = :expectedVersion',
    );
    expect(put.input.ExpressionAttributeValues).toEqual({ ':expectedVersion': 2 });
  });

  it('throws RetentionConfigConflictError when a concurrent PUT already advanced the version', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          pk: 'DEPT#NICHOLS',
          sk: 'CONFIG#RETENTION',
          entityType: 'DEPARTMENT_CONFIG',
          configType: 'RETENTION',
          value: { retentionYears: 7 },
          version: 2,
        },
      })
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        }),
      );
    const client = fakeDocClient(send);

    await expect(
      putRetentionConfig(client, {
        deptId: DEPT_ID,
        retentionYears: 12,
        actorId: 'MBR-0001',
      }),
    ).rejects.toThrow(RetentionConfigConflictError);
  });
});
