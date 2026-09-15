import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ClaimOutcome =
  | { readonly kind: 'CLAIMED'; readonly claimedAt: number }
  | { readonly kind: 'ALREADY_MINE'; readonly claimedAt: number }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'CONFLICT' };

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
    const gsi1sk = typeof startAt === 'number' ? `SHIFT_POSITION#${startAt}` : undefined;

    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk },
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(claimedByMemberId)',
        UpdateExpression:
          gsi1sk === undefined
            ? 'SET claimedByMemberId = :memberId, claimedAt = :claimedAt'
            : 'SET claimedByMemberId = :memberId, claimedAt = :claimedAt, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk',
        ExpressionAttributeValues: {
          ':memberId': memberId,
          ':claimedAt': claimedAt,
          ...(gsi1sk === undefined ? {} : { ':gsi1pk': `MEMBER#${memberId}`, ':gsi1sk': gsi1sk }),
        },
      }),
    );
    return { kind: 'CLAIMED', claimedAt };
  } catch (error) {
    if (error instanceof ShiftPositionWriteError) {
      throw error;
    }
    if (!(error instanceof ConditionalCheckFailedException)) {
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
