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
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { markSyncFailed, markSyncing, parseSyncRequest } from './entitySync.js';

let cachedLambda: LambdaClient | undefined;
function getLambdaClient(): LambdaClient {
  cachedLambda ??= new LambdaClient({});
  return cachedLambda;
}

function readWorkerName(): string {
  const name = process.env.NERIS_ENTITY_SYNC_WORKER;
  if (!name) throw new Error('NERIS_ENTITY_SYNC_WORKER is required and was not set');
  return name;
}

function problem(status: number, title: string, detail: string, traceId: string, code: string) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status, detail, traceId, code }),
  };
}

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
 * PUT /api/v1/platform/neris/entity (admin/chief) — start registering or updating the
 * department's stations and units with its NERIS entity. Answers 202 at once; the sync
 * worker makes the NERIS calls and GET reports SYNCING, then SYNCED or PARTIAL with every
 * station and unit, its NERIS id and the errors to fix.
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
    if (typeof config?.value.departmentNerisId !== 'string') {
      return problem(
        409,
        'Conflict',
        "Set the department's NERIS id (platform config NERIS) before syncing stations and units.",
        traceId,
        'NOT_CONFIGURED',
      );
    }
    const startedAt = new Date();
    const syncStartedAt = startedAt.toISOString();
    const started = await markSyncing(client, tableName, deptId, parsed, principal.sub, startedAt);
    if (started === 'already_running') {
      return problem(
        409,
        'Conflict',
        'A NERIS sync is already running for the department.',
        traceId,
        'SYNC_RUNNING',
      );
    }
    // One NERIS call per station and unit can outlast API Gateway's 30 s limit: the worker
    // runs it asynchronously and GET /platform/neris/entity reports progress.
    try {
      await getLambdaClient().send(
        new InvokeCommand({
          FunctionName: readWorkerName(),
          InvocationType: 'Event',
          // syncStartedAt identifies this sync: a delayed or superseded job exits (Q4).
          Payload: Buffer.from(JSON.stringify({ deptId, correlationId: traceId, syncStartedAt })),
        }),
      );
    } catch (error) {
      // Nothing will run: release the row now rather than leave it SYNCING (round 2, N9).
      await markSyncFailed(
        client,
        tableName,
        deptId,
        "The sync couldn't be started. Try again.",
        new Date(),
        syncStartedAt,
      ).catch(() => undefined);
      throw error;
    }
    logger.info({ event: 'platform.neris.entity.sync_started', correlationId: traceId, deptId });
    return json(202, { status: 'SYNCING', startedAt: syncStartedAt });
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
