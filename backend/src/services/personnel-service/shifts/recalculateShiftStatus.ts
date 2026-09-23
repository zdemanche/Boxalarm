import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { queryShiftItems } from './coverageRepository.js';

export type DutyShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL';

export type RecalculateOutcome =
  | { readonly kind: 'UPDATED'; readonly status: DutyShiftStatus }
  | { readonly kind: 'SKIPPED_CANCELLED' }
  | { readonly kind: 'NOT_FOUND' };

const MAX_RECALCULATE_ATTEMPTS = 5;

export async function recalculateShiftStatus(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
): Promise<RecalculateOutcome> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);

  for (let attempt = 0; attempt < MAX_RECALCULATE_ATTEMPTS; attempt += 1) {
    const items = await queryShiftItems(doc, tableName, pk);
    const shift = items.find((item) => item.sk === 'METADATA');
    if (!shift) {
      return { kind: 'NOT_FOUND' };
    }
    if (shift.status === 'CANCELLED') {
      return { kind: 'SKIPPED_CANCELLED' };
    }

    const positions = items.filter(
      (item) => typeof item.sk === 'string' && item.sk.startsWith('POSITION#'),
    );
    const claimedCount = positions.filter((item) => item.claimedByMemberId !== undefined).length;
    const status: DutyShiftStatus =
      claimedCount === 0 ? 'OPEN' : claimedCount === positions.length ? 'FULL' : 'PARTIALLY_FILLED';

    const currentVersion = typeof shift.version === 'number' ? shift.version : 0;

    try {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          ConditionExpression:
            'attribute_exists(pk) AND (attribute_not_exists(version) OR version = :expectedVersion)',
          UpdateExpression: 'SET #status = :status, version = :nextVersion',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':expectedVersion': currentVersion,
            ':nextVersion': currentVersion + 1,
          },
        }),
      );
      return { kind: 'UPDATED', status };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }

  throw new Error(
    `recalculateShiftStatus for shift ${shiftId} exceeded ${MAX_RECALCULATE_ATTEMPTS} attempts due to concurrent writers`,
  );
}
