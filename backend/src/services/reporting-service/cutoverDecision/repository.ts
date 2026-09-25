import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logError } from '../logger.js';

export type CutoverDecisionStatus = 'accept' | 'defer';

export interface CutoverDecisionRecord {
  readonly decision: CutoverDecisionStatus;
  readonly decider: string;
  readonly decidedAt: number;
}

export class CutoverDecisionRepositoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super('cutover decision store is unavailable');
    this.name = 'CutoverDecisionRepositoryUnavailableError';
    this.cause = cause;
  }
}

export async function getCutoverDecision(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<CutoverDecisionRecord | undefined> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: buildDeptScopedPk(deptId, 'CUTOVER_DECISION'),
          sk: 'CURRENT',
        },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return {
      decision: result.Item.decision as CutoverDecisionStatus,
      decider: result.Item.decider as string,
      decidedAt: result.Item.decidedAt as number,
    };
  } catch (error) {
    logError('reporting.cutoverDecision.repository.get_failed', error, { deptId });
    throw new CutoverDecisionRepositoryUnavailableError(error);
  }
}

export async function recordCutoverDecision(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  record: CutoverDecisionRecord,
): Promise<void> {
  const pk = buildDeptScopedPk(deptId, 'CUTOVER_DECISION');
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: 'CURRENT',
                entityType: 'CUTOVER_DECISION',
                ...record,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `DECISION#${record.decidedAt}`,
                entityType: 'CUTOVER_DECISION_HISTORY',
                ...record,
              },
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons ?? []).map((entry) => entry.Code)
        : undefined;
    logError('reporting.cutoverDecision.repository.record_failed', error, {
      deptId,
      ...(cancellationReasons ? { cancellationReasons } : {}),
    });
    throw new CutoverDecisionRepositoryUnavailableError(error);
  }
}
