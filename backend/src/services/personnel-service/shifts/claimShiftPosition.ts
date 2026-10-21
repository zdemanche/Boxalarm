import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ClaimOutcome =
  | { readonly kind: 'CLAIMED'; readonly claimedAt: number }
  | { readonly kind: 'ALREADY_MINE'; readonly claimedAt: number }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'CONFLICT' }
  | { readonly kind: 'SHIFT_CLOSED' }
  | { readonly kind: 'NOT_QUALIFIED'; readonly requiredQual: string };

export class ShiftPositionWriteError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB write for the shift-position claim failed');
    this.name = 'ShiftPositionWriteError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function claimShiftPosition(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  positionCode: string,
  memberId: string,
): Promise<ClaimOutcome> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
  const sk = `POSITION#${positionCode}`;
  const claimedAt = Date.now();
  const eventId = randomUUID();
  let requiredQual: string | undefined;

  try {
    const shiftMetadata = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk, sk: 'METADATA' },
        ConsistentRead: true,
      }),
    );
    const startAt: unknown = shiftMetadata.Item?.startAt;
    if (shiftMetadata.Item !== undefined && typeof startAt !== 'number') {
      throw new ShiftPositionWriteError(
        new Error(
          `DUTY_SHIFT metadata for shift ${shiftId} is missing a numeric startAt; refusing to persist a SHIFT_POSITION that violates the entity contract`,
        ),
      );
    }
    const endAt: unknown = shiftMetadata.Item?.endAt;
    const gsi1sk = typeof startAt === 'number' ? `SHIFT_POSITION#${startAt}` : undefined;

    const positionItem = await doc.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
    );
    if (
      shiftMetadata.Item?.status === 'CANCELLED' ||
      (typeof endAt === 'number' && endAt <= claimedAt)
    ) {
      if (positionItem.Item?.claimedByMemberId === memberId) {
        const heldSince: unknown = positionItem.Item.claimedAt;
        return {
          kind: 'ALREADY_MINE',
          claimedAt: typeof heldSince === 'number' ? heldSince : claimedAt,
        };
      }
      return { kind: 'SHIFT_CLOSED' };
    }
    const positionQual: unknown = positionItem.Item?.requiredQual;
    requiredQual = typeof positionQual === 'string' ? positionQual : undefined;

    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              ConditionExpression:
                requiredQual === undefined
                  ? 'attribute_exists(pk) AND attribute_not_exists(claimedByMemberId) AND attribute_not_exists(requiredQual)'
                  : 'attribute_exists(pk) AND attribute_not_exists(claimedByMemberId) AND requiredQual = :requiredQual',
              UpdateExpression:
                gsi1sk === undefined
                  ? 'SET claimedByMemberId = :memberId, claimedAt = :claimedAt'
                  : 'SET claimedByMemberId = :memberId, claimedAt = :claimedAt, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk',
              ExpressionAttributeValues: {
                ':memberId': memberId,
                ':claimedAt': claimedAt,
                ...(requiredQual === undefined ? {} : { ':requiredQual': requiredQual }),
                ...(gsi1sk === undefined
                  ? {}
                  : { ':gsi1pk': `MEMBER#${memberId}`, ':gsi1sk': gsi1sk }),
              },
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
                eventTime: new Date(claimedAt).toISOString(),
                eventType: 'personnel.shift.claimed',
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
          ...(requiredQual === undefined
            ? []
            : [
                {
                  ConditionCheck: {
                    TableName: tableName,
                    Key: {
                      pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
                      sk: `QUAL#${requiredQual}`,
                    },
                    ConditionExpression: 'currentlyEligible = :eligible',
                    ExpressionAttributeValues: { ':eligible': true },
                  },
                },
              ]),
        ],
      }),
    );
    return { kind: 'CLAIMED', claimedAt };
  } catch (error) {
    if (error instanceof ShiftPositionWriteError) {
      throw error;
    }
    if (!(error instanceof TransactionCanceledException)) {
      throw new ShiftPositionWriteError(error);
    }
    const reasons = error.CancellationReasons?.map((reason) => reason.Code) ?? [];
    if (reasons[0] !== 'ConditionalCheckFailed') {
      if (requiredQual !== undefined && reasons[2] === 'ConditionalCheckFailed') {
        return { kind: 'NOT_QUALIFIED', requiredQual };
      }
      throw new ShiftPositionWriteError(error);
    }
  }

  const existing = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
  const item = existing.Item;
  if (!item) {
    return { kind: 'NOT_FOUND' };
  }
  if (item.claimedByMemberId === memberId) {
    return {
      kind: 'ALREADY_MINE',
      claimedAt: typeof item.claimedAt === 'number' ? item.claimedAt : claimedAt,
    };
  }
  return { kind: 'CONFLICT' };
}
