import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { parseMaintenanceRecordItem, type MaintenanceRecordItem } from './maintenanceRecord.js';
import { apparatusNotFoundProblem } from './problemDetails.js';

interface GetMaintenanceDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

async function getMaintenance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: GetMaintenanceDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const apparatusId = event.pathParameters?.unitId;
  if (!apparatusId) {
    return apparatusNotFoundProblem(traceId);
  }
  const deptId = toVerifiedDeptId(principal);

  const result = await deps.client.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
        ':prefix': 'MAINT#',
      },
      ScanIndexForward: false,
    }),
  );

  const items = (result.Items ?? []) as readonly MaintenanceRecordItem[];
  const records = items.map((item) => parseMaintenanceRecordItem(item, apparatusId, deptId));
  const nextScheduled = records[0]?.scheduledNextAt ?? null;

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records, nextScheduled }),
  };
}

interface GetMaintenanceOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: GetMaintenanceOverrides): GetMaintenanceDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
  };
}

export function createGetMaintenanceHandler(
  overrides: GetMaintenanceOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => getMaintenance(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewMaintenanceHistory',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createGetMaintenanceHandler();
