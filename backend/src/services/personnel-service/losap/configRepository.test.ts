import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  getLosapPointRules,
  putLosapPointRules,
  LosapConfigConflictError,
} from './configRepository.js';
import { LosapRepositoryUnavailableError } from './repository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE = 'platform-service';
const ACTOR_ID = 'mbr-admin-1';

function fakeClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('getLosapPointRules', () => {
  it('returns undefined when no DEPARTMENT_CONFIG item exists (greenfield dept)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const rules = await getLosapPointRules(fakeClient(send), TABLE, DEPT_ID);
    expect(rules).toBeUndefined();
  });

  it('reads the versioned rule set from the DEPT#{deptId}/CONFIG#LOSAP_POINT_RULES item (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({
      Item: {
        pk: 'DEPT#NICHOLS',
        sk: 'CONFIG#LOSAP_POINT_RULES',
        value: { ruleVersionId: 'RULE-2026', pointsByActivityType: { CALL: 2 } },
        version: 3,
      },
    });
    const rules = await getLosapPointRules(fakeClient(send), TABLE, DEPT_ID);

    expect(rules).toEqual({
      ruleVersionId: 'RULE-2026',
      pointsByActivityType: { CALL: 2 },
      version: 3,
    });
    const call = send.mock.calls[0]?.[0] as { input: { Key: Record<string, string> } };
    expect(call.input.Key).toEqual({ pk: 'DEPT#NICHOLS', sk: 'CONFIG#LOSAP_POINT_RULES' });
  });

  it('wraps a DynamoDB failure in LosapRepositoryUnavailableError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(getLosapPointRules(fakeClient(send), TABLE, DEPT_ID)).rejects.toThrow(
      LosapRepositoryUnavailableError,
    );
  });
});

describe('putLosapPointRules', () => {
  it('mints a new ruleVersionId and writes version 1 when no config exists yet (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await putLosapPointRules(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      { CALL: 2 },
      undefined,
      ACTOR_ID,
    );

    expect(result.version).toBe(1);
    expect(result.ruleVersionId).toMatch(/^RULE-/);
    const call = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: Array<{
          Put: { Item: Record<string, unknown>; ConditionExpression: string };
        }>;
      };
    };
    const [configPut, auditPut] = call.input.TransactItems;
    expect(configPut?.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(configPut?.Put.Item.pk).toBe('DEPT#NICHOLS');
    expect(configPut?.Put.Item.sk).toBe('CONFIG#LOSAP_POINT_RULES');
    expect(configPut?.Put.Item.configType).toBe('LOSAP_POINT_RULES');
    expect(auditPut?.Put.Item.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(auditPut?.Put.Item.mutatedEntityType).toBe('DEPARTMENT_CONFIG');
    expect(auditPut?.Put.Item.mutatedEntityId).toBe('LOSAP_POINT_RULES');
    expect(auditPut?.Put.Item.action).toBe('CREATE');
    expect(auditPut?.Put.Item.actorId).toBe(ACTOR_ID);
  });

  it('mints a fresh ruleVersionId distinct from the prior version on a rule change (AC1, AC5 precondition)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const first = await putLosapPointRules(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      { CALL: 2 },
      undefined,
      ACTOR_ID,
    );
    const second = await putLosapPointRules(
      fakeClient(send),
      TABLE,
      DEPT_ID,
      { CALL: 3 },
      first.version,
      ACTOR_ID,
      { CALL: 2 },
    );

    expect(second.ruleVersionId).not.toBe(first.ruleVersionId);
    expect(second.version).toBe(2);
    const call = send.mock.calls[1]?.[0] as {
      input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> };
    };
    expect(call.input.TransactItems[0]?.Put.Item.pk).toBe('DEPT#NICHOLS');
    expect(call.input.TransactItems[1]?.Put.Item.action).toBe('UPDATE');
    expect(
      (call.input.TransactItems[1]?.Put.Item.changedFields as { pointsByActivityType: unknown })
        .pointsByActivityType,
    ).toEqual({ old: { CALL: 2 }, new: { CALL: 3 } });
  });

  it('raises LosapConfigConflictError on an optimistic-lock version mismatch', async () => {
    const send = vi.fn().mockRejectedValue(
      new TransactionCanceledException({
        message: 'conflict',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    await expect(
      putLosapPointRules(fakeClient(send), TABLE, DEPT_ID, { CALL: 2 }, 1, ACTOR_ID),
    ).rejects.toThrow(LosapConfigConflictError);
  });

  it('wraps any other DynamoDB failure in LosapRepositoryUnavailableError', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(
      putLosapPointRules(fakeClient(send), TABLE, DEPT_ID, { CALL: 2 }, undefined, ACTOR_ID),
    ).rejects.toThrow(LosapRepositoryUnavailableError);
  });
});
