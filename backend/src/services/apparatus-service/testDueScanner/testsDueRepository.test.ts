import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryTestsDue } from './testsDueRepository.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { PLATFORM_TABLE_NAME: 'platform-service' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('queryTestsDue', () => {
  it('queries GSI2 on the stable DUE#APPARATUS_TEST partition with a gsi2sk range, and reads apparatusId/testType/dueDate directly off the item', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ apparatusId: 'APP-ENGINE-2', testType: 'HOSE', nextDueDate: '2026-09-20' }],
    });
    const client = fakeClient(send);

    const result = await queryTestsDue(client, env, {
      deptId,
      startDate: '2026-09-14',
      endDate: '2026-10-14',
      correlationId: 'trace-1',
    });

    expect(result).toEqual([
      { apparatusId: 'APP-ENGINE-2', testType: 'HOSE', dueDate: '2026-09-20' },
    ]);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input.KeyConditionExpression).toBe(
      'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :start AND :end',
    );
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi2pk': 'DEPT#NICHOLS#DUE#APPARATUS_TEST',
      ':start': '2026-09-14',
      ':end': '2026-10-14#￿',
    });
  });

  it('paginates via ExclusiveStartKey/LastEvaluatedKey', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ apparatusId: 'APP-1', testType: 'HOSE', nextDueDate: '2026-09-01' }],
        LastEvaluatedKey: { pk: 'x', sk: 'y' },
      })
      .mockResolvedValueOnce({
        Items: [{ apparatusId: 'APP-2', testType: 'PUMP', nextDueDate: '2026-09-02' }],
      });
    const client = fakeClient(send);

    const result = await queryTestsDue(client, env, {
      deptId,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      correlationId: 'trace-2',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('logs the original error and rethrows on a dependency failure (fail-closed)', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      queryTestsDue(client, env, {
        deptId,
        startDate: '2026-09-14',
        endDate: '2026-10-14',
        correlationId: 'trace-4',
      }),
    ).rejects.toBe(failure);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('testDueScanner.queryDue.failed');
    expect(logged.message).toBe('DynamoDB unavailable');
    errorSpy.mockRestore();
  });
});
