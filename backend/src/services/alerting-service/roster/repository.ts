import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { parseRosterEntryItem, type RosterEntryItem } from '../dispatchRosterEntry.js';

export async function queryRoster(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<readonly RosterEntryItem[]> {
  const items: RosterEntryItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          ':skPrefix': 'ROSTER#',
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const parsed = parseRosterEntryItem(item as Record<string, unknown>);
      if (parsed !== undefined) {
        items.push(parsed);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}
