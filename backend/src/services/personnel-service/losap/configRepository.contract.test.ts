import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { getLosapPointRules } from './configRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-service';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('LOSAP point-rule config contract', () => {
  it('issues a GetCommand against the DEPARTMENT_CONFIG item, not a compiled constant (ticket test note)', async () => {
    const send = vi.fn().mockResolvedValue({});
    await getLosapPointRules(fakeClient(send), TABLE, DEPT_ID);

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as {
      constructor: { name: string };
      input: { TableName: string; Key: Record<string, string> };
    };
    expect(call.constructor.name).toBe('GetCommand');
    expect(call.input.TableName).toBe(TABLE);
    expect(call.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#LOSAP_POINT_RULES' });
  });

  it('returns whatever the config table holds rather than a fixed map, proving it is not hardcoded', async () => {
    const sendA = vi.fn().mockResolvedValue({
      Item: { value: { ruleVersionId: 'RULE-A', pointsByActivityType: { CALL: 1 } }, version: 1 },
    });
    const sendB = vi.fn().mockResolvedValue({
      Item: { value: { ruleVersionId: 'RULE-B', pointsByActivityType: { CALL: 9 } }, version: 2 },
    });

    const rulesA = await getLosapPointRules(fakeClient(sendA), TABLE, DEPT_ID);
    const rulesB = await getLosapPointRules(fakeClient(sendB), TABLE, DEPT_ID);

    expect(rulesA?.pointsByActivityType.CALL).toBe(1);
    expect(rulesB?.pointsByActivityType.CALL).toBe(9);
  });
});
