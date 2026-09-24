import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { queryMemberDispatchTimeline } from '../audit/queryAuditLog.js';
import { getDeviceState, type DeviceState } from '../devices/deviceStateRepository.js';

export interface MemberDiagnostics {
  readonly onEligibleRoster: boolean;
  readonly timeline: readonly Record<string, unknown>[];
  readonly deviceState: DeviceState | null;
}

export async function queryMemberDiagnostics(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
): Promise<MemberDiagnostics> {
  const rosterResult = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: `ROSTER#${memberId}` },
    }),
  );
  const onEligibleRoster = rosterResult.Item !== undefined;

  const [timeline, deviceState] = await Promise.all([
    onEligibleRoster
      ? queryMemberDispatchTimeline(client, tableName, deptId, dispatchId, memberId)
      : Promise.resolve([]),
    getDeviceState(client, tableName, deptId, memberId),
  ]);

  return { onEligibleRoster, timeline, deviceState: deviceState ?? null };
}
