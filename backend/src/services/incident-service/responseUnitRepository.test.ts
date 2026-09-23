import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { upsertResponseUnitTimes } from './responseUnitRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('upsertResponseUnitTimes', () => {
  it('independently sets each provided timestamp field (E6-S5 AC1)', async () => {
    const send = vi.fn().mockResolvedValue({
      Attributes: {
        incidentId: 'NICHOLS-4471-1798000000',
        unitId: 'E1',
        unitType: 'APPARATUS',
        dispatchedAt: 100,
        arrivedAt: 200,
      },
    });
    const result = await upsertResponseUnitTimes(fakeClient(send), TABLE_NAME, {
      deptId: DEPT_ID,
      incidentId: 'NICHOLS-4471-1798000000',
      unitId: 'E1',
      unitType: 'APPARATUS',
      times: { dispatchedAt: 100, arrivedAt: 200 },
    });

    expect(result).toMatchObject({ unitId: 'E1', dispatchedAt: 100, arrivedAt: 200 });
    const [command] = send.mock.calls[0] as [{ input: { Key: unknown; UpdateExpression: string } }];
    expect(command.input.Key).toEqual({
      pk: 'DEPT#NICHOLS#INCIDENT#NICHOLS-4471-1798000000',
      sk: 'RESPONSE#E1',
    });
    expect(command.input.UpdateExpression).toMatch(/dispatchedAt = :dispatchedAt/);
    expect(command.input.UpdateExpression).toMatch(/arrivedAt = :arrivedAt/);
    expect(command.input.UpdateExpression).not.toMatch(/enRouteAt/);
  });

  it('keys distinct units under distinct sk values for the same incident (E6-S5 AC3)', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Attributes: { incidentId: 'X', unitId: 'MBR-1', unitType: 'MEMBER' } });

    await upsertResponseUnitTimes(fakeClient(send), TABLE_NAME, {
      deptId: DEPT_ID,
      incidentId: 'NICHOLS-4471-1798000000',
      unitId: 'MBR-1',
      unitType: 'MEMBER',
      times: { arrivedAt: 300 },
    });
    await upsertResponseUnitTimes(fakeClient(send), TABLE_NAME, {
      deptId: DEPT_ID,
      incidentId: 'NICHOLS-4471-1798000000',
      unitId: 'E1',
      unitType: 'APPARATUS',
      times: { arrivedAt: 305 },
    });

    const keys = send.mock.calls.map(
      ([command]) => (command as { input: { Key: { sk: string } } }).input.Key.sk,
    );
    expect(keys).toEqual(['RESPONSE#MBR-1', 'RESPONSE#E1']);
  });
});
