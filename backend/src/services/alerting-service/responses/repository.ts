import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { AckStatus } from '../dispatchRosterEntry.js';
import { logError, logInfo } from '../dispatches/logger.js';

export type ResponseAckStatus = Exclude<AckStatus, 'NONE'>;

export interface RecordResponseInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly ackStatus: ResponseAckStatus;
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
  readonly answeredAt: number;
}

export type RecordResponseResult =
  { readonly outcome: 'recorded' } | { readonly outcome: 'dispatch-not-found' };

const ROSTER_UPDATE_INDEX = 1;

export async function recordResponse(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
): Promise<RecordResponseResult> {
  const { deptId, dispatchId, memberId, ackStatus, eta, assignedApparatusId, answeredAt } = input;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  const dispatch = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
  );
  if (!dispatch.Item) {
    return { outcome: 'dispatch-not-found' };
  }
  const toneSequence = (dispatch.Item.currentToneSequence as number | undefined) ?? 1;

  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk,
            sk: `RESPONSE#${memberId}#${answeredAt}`,
            entityType: 'DISPATCH_RESPONSE_RECORD',
            memberId,
            ackStatus,
            toneSequence,
            eta,
            assignedApparatusId,
            answeredAt,
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk: `ROSTER#${memberId}` },
          UpdateExpression:
            'SET entityType = :entityType, memberId = :memberId, ackStatus = :ackStatus, ackAt = :ackAt, eta = :eta, assignedApparatusId = :assignedApparatusId, lastAnsweredTone = :toneSequence, quals = if_not_exists(quals, :emptyQuals)',
          ConditionExpression: 'attribute_not_exists(ackAt) OR :ackAt > ackAt',
          ExpressionAttributeValues: {
            ':entityType': 'DISPATCH_ROSTER_ENTRY',
            ':memberId': memberId,
            ':ackStatus': ackStatus,
            ':ackAt': answeredAt,
            ':eta': eta,
            ':assignedApparatusId': assignedApparatusId,
            ':toneSequence': toneSequence,
            ':emptyQuals': [],
          },
        },
      },
    ],
  });

  try {
    await client.send(command);
    return { outcome: 'recorded' };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const rosterReason = error.CancellationReasons?.[ROSTER_UPDATE_INDEX];
      if (rosterReason?.Code === 'ConditionalCheckFailed') {
        logInfo('responses.record.stale_write_skipped', {
          deptId,
          dispatchId,
          memberId,
        });
        return { outcome: 'recorded' };
      }
    }
    logError('responses.record.failed', error, { deptId, dispatchId, memberId });
    throw error;
  }
}
