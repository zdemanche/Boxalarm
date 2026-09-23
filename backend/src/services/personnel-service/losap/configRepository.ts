import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { LosapRepositoryUnavailableError, logLosapError } from './repository.js';
import type { LosapPointRules } from './rules.js';

const CONFIG_SK = 'CONFIG#LOSAP_POINT_RULES';

export interface LosapRuleConfig {
  readonly ruleVersionId: string;
  readonly pointsByActivityType: LosapPointRules;
  readonly version: number;
}

export class LosapConfigConflictError extends Error {
  constructor() {
    super('LOSAP point rule config changed concurrently; retry with the latest version');
    this.name = 'LosapConfigConflictError';
  }
}

export async function getLosapPointRules(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<LosapRuleConfig | undefined> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: CONFIG_SK },
      }),
    );
    const item = result.Item;
    if (!item) {
      return undefined;
    }
    const value = item.value as { ruleVersionId: string; pointsByActivityType: LosapPointRules };
    return {
      ruleVersionId: value.ruleVersionId,
      pointsByActivityType: value.pointsByActivityType,
      version: item.version as number,
    };
  } catch (error) {
    logLosapError('losap.configRepository.getLosapPointRules.failed', error, { deptId });
    throw new LosapRepositoryUnavailableError(error);
  }
}

export async function putLosapPointRules(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  pointsByActivityType: LosapPointRules,
  expectedVersion: number | undefined,
  actorId: string,
  previousPointsByActivityType?: LosapPointRules,
): Promise<{ ruleVersionId: string; version: number }> {
  const ruleVersionId = `RULE-${randomUUID()}`;
  const version = (expectedVersion ?? 0) + 1;
  const now = Date.now();
  const changedAt = new Date(now).toISOString();
  const auditDate = changedAt.slice(0, 10);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId),
                sk: CONFIG_SK,
                entityType: 'DEPARTMENT_CONFIG',
                configType: 'LOSAP_POINT_RULES',
                value: { ruleVersionId, pointsByActivityType },
                version,
              },
              ConditionExpression:
                expectedVersion === undefined
                  ? 'attribute_not_exists(pk)'
                  : 'version = :expectedVersion',
              ...(expectedVersion === undefined
                ? {}
                : { ExpressionAttributeValues: { ':expectedVersion': expectedVersion } }),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'AUDIT', auditDate),
                sk: `${now}#DEPARTMENT_CONFIG#LOSAP_POINT_RULES#${actorId}`,
                entityType: 'AUDIT_LOG_ENTRY',
                mutatedEntityType: 'DEPARTMENT_CONFIG',
                mutatedEntityId: 'LOSAP_POINT_RULES',
                action: expectedVersion === undefined ? 'CREATE' : 'UPDATE',
                actorId,
                changedFields: {
                  pointsByActivityType: {
                    old: previousPointsByActivityType ?? null,
                    new: pointsByActivityType,
                  },
                },
                ts: now,
                gsi3pk: buildDeptScopedPk(
                  deptId,
                  'AUDIT',
                  'ENTITY',
                  'DEPARTMENT_CONFIG',
                  'LOSAP_POINT_RULES',
                ),
                gsi3sk: changedAt,
              },
            },
          },
        ],
      }),
    );
    return { ruleVersionId, version };
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons ?? []).map((reason) => reason.Code)
        : undefined;
    if (cancellationReasons?.includes('ConditionalCheckFailed')) {
      throw new LosapConfigConflictError();
    }
    logLosapError('losap.configRepository.putLosapPointRules.failed', error, {
      deptId,
      ...(cancellationReasons ? { cancellationReasons } : {}),
    });
    throw new LosapRepositoryUnavailableError(error);
  }
}
