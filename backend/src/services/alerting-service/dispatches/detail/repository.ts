import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
