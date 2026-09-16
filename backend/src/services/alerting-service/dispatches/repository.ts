import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { DispatchReceived, SourceSystem } from './dispatchIngressPort.js';
import { logError, logInfo } from './logger.js';

export interface CreateManualDispatchInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatch: DispatchReceived;
  readonly idempotencyKey: string;
  readonly dispatchedAt: number;
  readonly targetMemberId?: string;
  readonly selfTestId?: string;
  readonly channelsTested?: readonly string[];
}

export type CreateManualDispatchResult =
  { readonly outcome: 'created'; readonly dispatchId: string } | { readonly outcome: 'duplicate' };

const LOCK_ITEM_INDEX = 0;
const TEST_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365;

function mintDispatchId(
  deptId: VerifiedDeptId,
  dispatchedAt: number,
  sourceSystem: SourceSystem,
): string {
  const kind = sourceSystem === 'SELF_TEST' ? 'SELFTEST' : 'MANUAL';
  return `${deptId}-${kind}-${dispatchedAt}-${randomUUID().slice(0, 8)}`;
}

export async function createManualDispatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: CreateManualDispatchInput,
): Promise<CreateManualDispatchResult> {
  const { deptId, dispatch, idempotencyKey, dispatchedAt } = input;
  const dispatchId = mintDispatchId(deptId, dispatchedAt, dispatch.sourceSystem);
  const isTest = dispatch.sourceSystem === 'SELF_TEST';

  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(
              deptId,
              'DISPATCH_IDEMPOTENCY',
              dispatch.sourceSystem,
              dispatch.externalDispatchId,
            ),
            sk: 'LOCK',
            entityType: 'DISPATCH_IDEMPOTENCY_LOCK',
            idempotencyKey,
            dispatchId,
            deptId,
            createdAt: dispatchedAt,
          },
          ConditionExpression: 'attribute_not_exists(idempotencyKey)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
            sk: 'METADATA',
            entityType: 'DISPATCH_ALERT',
            dispatchId,
            deptId,
            sourceSystem: dispatch.sourceSystem,
            incidentType: dispatch.incidentType,
            address: dispatch.address,
            crossStreets: dispatch.crossStreets,
            unitsRequested: dispatch.unitsRequested,
            narrative: dispatch.narrative,
            idempotencyKey,
            dispatchedAt,
            createdAt: dispatchedAt,
            toneLadderStatus: 'ACTIVE',
            currentToneSequence: 1,
            nextToneAt: null,
            isTest,
            ...(input.targetMemberId ? { targetMemberId: input.targetMemberId } : {}),
            ...(input.selfTestId ? { selfTestId: input.selfTestId } : {}),
            ...(input.channelsTested ? { channelsTested: input.channelsTested } : {}),
            ...(isTest
              ? { ttl: dispatchedAt + TEST_AUDIT_TTL_SECONDS }
              : { gsi2pk: buildDeptScopedPk(deptId), gsi2sk: `DISPATCH#${dispatchedAt}` }),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ],
  });

  try {
    await client.send(command);
    return { outcome: 'created', dispatchId };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const lockReason = error.CancellationReasons?.[LOCK_ITEM_INDEX];
      if (lockReason?.Code === 'ConditionalCheckFailed') {
        logInfo('dispatches.create.duplicate', {
          deptId,
          externalDispatchId: dispatch.externalDispatchId,
          cancellationReasons: error.CancellationReasons,
        });
        return { outcome: 'duplicate' };
      }
    }
    logError('dispatches.create.failed', error, {
      deptId,
      externalDispatchId: dispatch.externalDispatchId,
    });
    throw error;
  }
}
