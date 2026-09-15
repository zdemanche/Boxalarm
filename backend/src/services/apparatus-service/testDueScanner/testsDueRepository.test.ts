import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { queryTestsDueInMonth } from './testsDueRepository.js';

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { PLATFORM_TABLE_NAME: 'platform-service' };

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('queryTestsDueInMonth', () => {
  it('queries GSI2 on DUE#APPARATUS_TEST#{yearMonth} and parses gsi2sk into apparatusId/testType/dueDate', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ gsi2sk: '2026-09-20#APP-ENGINE-2#HOSE' }],
    });
    const client = fakeClient(send);

    const result = await queryTestsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-09',
      correlationId: 'trace-1',
    });

    expect(result).toEqual([
      { apparatusId: 'APP-ENGINE-2', testType: 'HOSE', dueDate: '2026-09-20' },
    ]);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi2pk': 'DEPT#NICHOLS#DUE#APPARATUS_TEST#2026-09',
    });
  });

  it('paginates via ExclusiveStartKey/LastEvaluatedKey', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ gsi2sk: '2026-09-01#APP-1#HOSE' }],
        LastEvaluatedKey: { pk: 'x', sk: 'y' },
      })
      .mockResolvedValueOnce({ Items: [{ gsi2sk: '2026-09-02#APP-2#PUMP' }] });
    const client = fakeClient(send);

    const result = await queryTestsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-09',
      correlationId: 'trace-2',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('skips a malformed gsi2sk rather than crashing', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ gsi2sk: 'not-well-formed' }] });
    const client = fakeClient(send);

    const result = await queryTestsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-09',
      correlationId: 'trace-3',
    });

    expect(result).toEqual([]);
  });

  it('logs the original error and rethrows on a dependency failure (fail-closed)', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      queryTestsDueInMonth(client, env, { deptId, yearMonth: '2026-09', correlationId: 'trace-4' }),
    ).rejects.toBe(failure);

    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('testDueScanner.queryDueInMonth.failed');
    errorSpy.mockRestore();
  });
});
