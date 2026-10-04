import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventHeaders, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import {
  getAccessStoreClient,
  listMemberDevices,
  readPlatformTableName,
} from './memberAccessStore.js';

function extractTraceId(headers: APIGatewayProxyEventHeaders): string {
  const traceparent = headers.traceparent ?? headers.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function problemDetails(
  statusCode: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: 'about:blank', title, status: statusCode, detail, traceId }),
  };
}

function readMemberId(event: GuardEvent): string | undefined {
  const memberId = event.pathParameters?.memberId;
  return typeof memberId === 'string' && memberId.trim().length > 0 ? memberId : undefined;
}

async function listDevices(
  event: GuardEvent,
  authorizerContext: CedarPrincipalContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const traceId = extractTraceId(event.headers ?? {});
  const memberId = readMemberId(event);
  if (!memberId) {
    return problemDetails(400, 'Bad Request', 'memberId is required.', traceId);
  }

  let tableName: string;
  try {
    tableName = readPlatformTableName(process.env);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'listMemberDevices.configError',
        message: error instanceof Error ? error.message : undefined,
        traceId,
      }),
    );
    return problemDetails(
      500,
      'Internal Server Error',
      'Device listing is misconfigured.',
      traceId,
    );
  }

  let devices: Awaited<ReturnType<typeof listMemberDevices>>;
  try {
    // Keyed by the caller's verified department, so another department's member is a 404.
    devices = await listMemberDevices(
      getAccessStoreClient(),
      tableName,
      authorizerContext.deptId,
      memberId,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'listMemberDevices.readFailed',
        message: error instanceof Error ? error.message : undefined,
        memberId,
        traceId,
      }),
    );
    return problemDetails(
      503,
      'Service Unavailable',
      'Devices are temporarily unavailable.',
      traceId,
    );
  }
  if (devices === undefined) {
    return problemDetails(404, 'Not Found', `No member found for memberId "${memberId}".`, traceId);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ memberId, devices }),
  };
}

/**
 * GET /api/v1/platform/sessions/{memberId}/devices - the member's registered push devices
 * (installation id, platform, last registration time, whether the token still works), so an
 * admin reporting a device lost can remove just that one. Never the push token itself.
 * Cedar ViewMemberDevices (CHIEF/ADMIN, ADMIN_ONLY_ACTIONS), the roles that may report one.
 */
export const handler = withAuthorization(listDevices, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewMemberDevices',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => readMemberId(event) ?? '',
});
