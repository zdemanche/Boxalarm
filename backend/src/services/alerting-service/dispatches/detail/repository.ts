import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DispatchAlertItem {
  readonly dispatchId: string;
  readonly incidentType: string;
  readonly address: string;
  readonly crossStreets: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly mapLink?: string;
  readonly narrative: string;
  readonly eligibleMemberCount?: number;
  readonly fanOutStartedAt?: number;
  readonly prePlanRefs?: readonly string[];
  /** Dispatcher's locality choice (dispatchIngressPort.ts), when ingress captured one. */
  readonly locality?: { readonly town: string; readonly choice: 'HOME' | 'OTHER' };
  readonly toneLadderStatus?: string;
  readonly currentToneSequence?: number;
  readonly nextToneAt?: number | null;
}

export async function getDispatchDetail(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertItem | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'METADATA' },
    }),
  );
  return result.Item as DispatchAlertItem | undefined;
}

/** The MUTUAL_AID_EVENT singleton (architecture §3.1), or undefined if none was requested. */
export async function getMutualAidEvent(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'MUTUALAID#SINGLETON' },
    }),
  );
  return result.Item?.entityType === 'MUTUAL_AID_EVENT' ? result.Item : undefined;
}

export interface DispatchUpdateView {
  readonly updateId: string;
  readonly receivedAt: number;
  readonly summary: string;
  readonly changes: readonly { field: string; from: string; to: string }[];
}

/**
 * The CAD updates recorded for this dispatch (cadIngress/updateRepository.ts), oldest first.
 * Bounded: a dispatch with more than 100 updates shows the first 100.
 */
export async function getDispatchUpdates(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchUpdateView[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :update)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
        ':update': 'UPDATE#',
      },
      Limit: 100,
    }),
  );
  return (result.Items ?? [])
    .filter((item) => item.entityType === 'DISPATCH_UPDATE')
    .map((item) => ({
      updateId: String(item.updateId),
      receivedAt: Number(item.receivedAt),
      summary: typeof item.summary === 'string' ? item.summary : '',
      changes: Array.isArray(item.changes)
        ? (item.changes as { field: string; from: string; to: string }[])
        : [],
    }))
    .sort((a, b) => a.receivedAt - b.receivedAt);
}
