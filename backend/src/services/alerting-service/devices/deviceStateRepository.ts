import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface DeviceState {
  readonly memberId: string;
  readonly notificationPermission: boolean;
  readonly criticalAlertPermission: boolean;
  readonly batteryOptimizationExempt: boolean;
  readonly appVersion: string;
  readonly osVersion: string;
  readonly reportedAt: number;
}

export async function putDeviceState(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  state: DeviceState,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: buildDeptScopedPk(deptId, 'DEVICE', state.memberId),
        sk: 'STATE',
        entityType: 'DEVICE_STATE',
        deptId,
        ...state,
      },
    }),
  );
}

export async function getDeviceState(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<DeviceState | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DEVICE', memberId), sk: 'STATE' },
    }),
  );
  return result.Item as DeviceState | undefined;
}
