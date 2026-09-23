import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusConfig } from './client.js';
import {
  ApparatusRepositoryUnavailableError,
  isApparatusStatus,
  listApparatus,
  type ApparatusStatus,
} from './repository.js';

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function parseStatusFilter(value: string | undefined): ApparatusStatus | undefined {
  return isApparatusStatus(value) ? value : undefined;
}

async function listRegistry(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  try {
    const deptId = toVerifiedDeptId(principal);
    const client = createDynamoClient(process.env);
    const config = readApparatusConfig(process.env);
    const statusFilter = parseStatusFilter(event.queryStringParameters?.status);
    const apparatus = await listApparatus(client, config.tableName, deptId, statusFilter);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apparatus }),
    };
  } catch (error) {
    if (error instanceof ApparatusRepositoryUnavailableError) {
      return serviceUnavailableProblem(traceId);
    }
    throw error;
  }
}

export const handler = withAuthorization(listRegistry, {
  actionType: 'Apparatus',
  actionId: 'ListApparatus',
  resourceType: 'Apparatus',
  resourceId: () => 'REGISTRY',
});
