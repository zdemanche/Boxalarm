import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  withAuthorization,
  serviceUnavailableProblem,
  forbiddenProblem,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { extractTraceId } from '../attendance/handler.js';
import { validationProblem } from '../attendance/problemDetails.js';
import { isAuthorized } from '../lib/authz.js';
import { getMemberLosapTotal } from './repository.js';

function currentYear(): number {
  return new Date().getUTCFullYear();
}

function logLosapQueryFailure(reason: string, error: unknown, traceId: string): void {
  console.error(
    JSON.stringify({
      event: 'losap.query_failed',
      service: 'personnel-service',
      reason,
      correlationId: traceId,
      originalError: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function getMemberLosap(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return validationProblem(traceId, 'memberId path parameter is required');
  }

  if (memberId !== principal.sub && isAuthorized(principal) === 'deny') {
    logLosapQueryFailure(
      'CrossMemberAccessDenied',
      new Error(`principal ${principal.sub} requested LOSAP total for member ${memberId}`),
      traceId,
    );
    return forbiddenProblem(traceId);
  }

  const deptId = toVerifiedDeptId(principal);
  const year = currentYear();

  try {
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
    const totalPoints = await getMemberLosapTotal(client, tableName, deptId, memberId, year);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, year, totalPoints }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logLosapQueryFailure(reason, error, traceId);
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getMemberLosap, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnLosapTotal',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
