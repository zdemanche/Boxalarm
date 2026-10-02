import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusServiceConfig } from './dynamoClient.js';
import { DefectRepositoryUnavailableError, listOpenDefects } from './defectRepository.js';

/**
 * GET /api/v1/apparatus/defects?status=open — every open defect in the department in one
 * request (owed-stories review minor 8: the web dashboard's to-do card fetched each unit's
 * detail). One GSI3 Query on the keys the DEFECT rows already carry; officer tier.
 */

function logListError(error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event: 'apparatus.defects.list_failed',
      service: 'apparatus-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      correlationId,
    }),
  );
}

interface ListOpenDefectsDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

async function listDefects(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: ListOpenDefectsDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  // Only the open list exists; an explicit contract so a future `resolved` filter is additive.
  if (event.queryStringParameters?.status !== 'open') {
    return badRequestProblem(traceId, 'status=open is required; no other filter exists.');
  }
  const deptId = toVerifiedDeptId(principal);
  try {
    const defects = await listOpenDefects(deps.client, deps.tableName, deptId);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defects }),
    };
  } catch (error) {
    logListError(error, traceId);
    if (error instanceof DefectRepositoryUnavailableError) {
      return serviceUnavailableProblem(traceId);
    }
    throw error;
  }
}

interface ListOpenDefectsOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: ListOpenDefectsOverrides): ListOpenDefectsDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusServiceConfig(process.env).tableName,
  };
}

export function createListOpenDefectsHandler(
  overrides: ListOpenDefectsOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => listDefects(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ListOpenDefects',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: () => 'DEFECTS',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createListOpenDefectsHandler();
