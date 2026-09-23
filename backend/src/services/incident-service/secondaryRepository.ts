import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface IncidentSecondary {
  readonly incidentId: string;
  readonly secondaryType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly affectedMemberIds: readonly string[];
  readonly updatedAt: number;
}

export async function putIncidentSecondary(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  secondary: IncidentSecondary,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'INCIDENT', secondary.incidentId),
        sk: `SECONDARY#${secondary.secondaryType}`,
        entityType: 'INCIDENT_SECONDARY',
        incidentId: secondary.incidentId,
        secondaryType: secondary.secondaryType,
        payload: secondary.payload,
        affectedMemberIds: secondary.affectedMemberIds,
        updatedAt: secondary.updatedAt,
      },
    }),
  );
}

/** AC3: each Secondary module comes back as its own distinct record, never merged. */
export async function queryIncidentSecondaries(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<readonly IncidentSecondary[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'SECONDARY#',
      },
    }),
  );
  return (result.Items ?? []) as unknown as IncidentSecondary[];
}
