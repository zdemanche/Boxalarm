import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { queryShiftItems } from './coverageRepository.js';

export type DutyShiftStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FULL';

export type RecalculateOutcome =
  | { readonly kind: 'UPDATED'; readonly status: DutyShiftStatus }
  | { readonly kind: 'SKIPPED_CANCELLED' }
  | { readonly kind: 'NOT_FOUND' };

const MAX_RECALCULATE_ATTEMPTS = 5;

function buildCoverageOutboxRecord(
  deptId: VerifiedDeptId,
  shiftId: string,
  endAt: unknown,
  positions: readonly Record<string, unknown>[],
) {
  const unclaimed = positions.filter((item) => item.claimedByMemberId === undefined);
  if (unclaimed.length === 0) {
    return buildOutboxRecord(
      deptId,
      'personnel-service',
      'scheduling.coverage_gap.resolved',
      shiftId,
      {
        deptId,
        shiftId,
      },
    );
  }
  const requiredQuals = [
    ...new Set(
      unclaimed.flatMap((item) =>
        typeof item.requiredQual === 'string' ? [item.requiredQual] : [],
      ),
    ),
  ];
  return buildOutboxRecord(
    deptId,
    'personnel-service',
    'scheduling.coverage_gap.detected',
    shiftId,
    {
      deptId,
      shiftId,
      gapReason: 'short',
      requiredQuals,
      ...(typeof endAt === 'number' ? { endAt } : {}),
    },
  );
}

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
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
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
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: buildCoverageOutboxRecord(deptId, shiftId, shift.endAt, positions),
              },
            },
          ],
        }),
      );
      return { kind: 'UPDATED', status };
    } catch (error) {
      const contended =
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (!contended) {
        throw error;
      }
    }
  }

  throw new Error(
    `recalculateShiftStatus for shift ${shiftId} exceeded ${MAX_RECALCULATE_ATTEMPTS} attempts due to concurrent writers`,
  );
}
