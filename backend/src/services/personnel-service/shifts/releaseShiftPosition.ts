import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ReleaseOutcome =
  | { readonly kind: 'RELEASED' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_CLAIMED_BY_YOU' };

export class ShiftPositionReleaseWriteError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB write for the shift-position release failed');
    this.name = 'ShiftPositionReleaseWriteError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function releaseShiftPosition(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  positionCode: string,
  memberId: string,
): Promise<ReleaseOutcome> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
  const sk = `POSITION#${positionCode}`;
  const eventId = randomUUID();
  const releasedAt = Date.now();

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              ConditionExpression: 'claimedByMemberId = :memberId',
              UpdateExpression: 'REMOVE claimedByMemberId, claimedAt, gsi1pk, gsi1sk',
              ExpressionAttributeValues: { ':memberId': memberId },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', memberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(releasedAt).toISOString(),
                eventType: 'personnel.shift.released',
                source: 'personnel-service',
                correlationId: shiftId,
                schemaVersion: '1.0',
                deptId,
                memberId,
                payload: { shiftId, positionCode, memberId, deptId },
                sentAt: null,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) {
      throw new ShiftPositionReleaseWriteError(error);
    }

    const reasons = error.CancellationReasons?.map((reason) => reason.Code) ?? [];
    if (reasons[0] !== 'ConditionalCheckFailed') {
      throw new ShiftPositionReleaseWriteError(error);
    }

    const existing = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    const item = existing.Item;
    if (!item) {
      return { kind: 'NOT_FOUND' };
    }
    return { kind: 'NOT_CLAIMED_BY_YOU' };
  }

  return { kind: 'RELEASED' };
}
