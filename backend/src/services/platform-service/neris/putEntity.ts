import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createLogger } from '@boxalarm/logging';
import { getDynamoDocClient } from '../export/awsClients.js';
import { getDepartmentConfig } from '../config/repository.js';
import { createNerisApi } from '../../incident-service/neris/api.js';
import { getNerisClient, readNerisConfig } from '../../incident-service/neris/index.js';
import { getEntityRecord, parseSyncRequest, saveEntityRecord, syncEntity } from './entitySync.js';

const logger = createLogger({ service: 'platform-service' });

function readTableName(): string {
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  return tableName;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * PUT /api/v1/platform/neris/entity (admin/chief) — register or update the department's
 * stations and units with its NERIS entity. Each station and unit succeeds or fails on its
 * own; the response lists every one with its NERIS id and the errors to fix.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  let body: unknown;
  try {
    body = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch {
    return badRequestProblem(traceId, 'request body must be JSON');
  }
  const parsed = parseSyncRequest(body);
  if (Array.isArray(parsed)) {
    return {
      statusCode: 400,
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'The station and unit list is not valid.',
        traceId,
        errors: parsed,
      }),
    };
  }
  try {
    const client = getDynamoDocClient();
    const tableName = readTableName();
    const config = await getDepartmentConfig(client, { tableName, deptId, configType: 'NERIS' });
    const departmentNerisId = config?.value.departmentNerisId;
    if (typeof departmentNerisId !== 'string') {
      return {
        statusCode: 409,
        headers: { 'content-type': 'application/problem+json' },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            "Set the department's NERIS id (platform config NERIS) before syncing stations and units.",
          traceId,
          code: 'NOT_CONFIGURED',
        }),
      };
    }
    const previous = await getEntityRecord(client, tableName, deptId);
    const api = createNerisApi(getNerisClient(await readNerisConfig(process.env)));
    const record = await syncEntity(
      api,
      departmentNerisId,
      parsed,
      previous,
      principal.sub,
      new Date(),
    );
    await saveEntityRecord(client, tableName, deptId, record, traceId);
    logger.info({
      event: 'platform.neris.entity.synced',
      correlationId: traceId,
      deptId,
      stations: record.stations.length,
      units: record.units.length,
      errors: record.errors.length,
    });
    return json(200, record);
  } catch (error) {
    logger.error({
      event: 'platform.neris.entity.sync_failed',
      correlationId: traceId,
      deptId,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'SyncNerisEntity',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
