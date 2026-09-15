import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export type AvailabilityState = 'AVAILABLE' | 'MARKED_OFF' | 'LOA';

export type EligibilitySnapshotItem = Record<'pk' | 'sk', string> & {
  readonly entityType: 'MEMBER_ELIGIBILITY_SNAPSHOT';
  readonly memberId: string;
  readonly active: boolean;
  readonly quals: readonly string[];
  readonly roles: readonly string[];
  readonly availabilityState: AvailabilityState;
  readonly snapshotUpdatedAt: number;
};

export function parseSnapshotItem(
  item: Record<string, unknown> | undefined,
): EligibilitySnapshotItem | undefined {
  if (!item) {
    return undefined;
  }
  const {
    pk,
    sk,
    entityType,
    memberId,
    active,
    quals,
    roles,
    availabilityState,
    snapshotUpdatedAt,
  } = item;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    entityType !== 'MEMBER_ELIGIBILITY_SNAPSHOT' ||
    typeof memberId !== 'string' ||
    typeof active !== 'boolean' ||
    !Array.isArray(quals) ||
    !Array.isArray(roles) ||
    (availabilityState !== 'AVAILABLE' &&
      availabilityState !== 'MARKED_OFF' &&
      availabilityState !== 'LOA') ||
    typeof snapshotUpdatedAt !== 'number'
  ) {
    throw new Error('MEMBER_ELIGIBILITY_SNAPSHOT item failed shape validation');
  }
  return {
    pk,
    sk,
    entityType,
    memberId,
    active,
    quals,
    roles,
    availabilityState,
    snapshotUpdatedAt,
  };
}

export async function queryEligiblePartition(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly EligibilitySnapshotItem[]> {
  const items: EligibilitySnapshotItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'ELIGIBILITY') },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const parsed = parseSnapshotItem(item as Record<string, unknown>);
      if (parsed !== undefined) {
        items.push(parsed);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}

export async function queryEligibleMembers(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly EligibilitySnapshotItem[]> {
  const items = await queryEligiblePartition(ddb, tableName, deptId);
  return items.filter((item) => item.active && item.availabilityState !== 'MARKED_OFF');
}
