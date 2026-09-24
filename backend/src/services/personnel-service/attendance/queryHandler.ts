import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  notFoundProblem,
  withAuthorization,
  serviceUnavailableProblem,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { extractTraceId, memberExists } from './handler.js';

function logQueryFailure(reason: string, error: unknown, traceId: string): void {
  console.error(
    JSON.stringify({
      event: 'attendance.query_failed',
      service: 'personnel-service',
      reason,
      correlationId: traceId,
      originalError: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function queryAttendanceFor(
  event: GuardEvent,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);

  try {
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);

    // Cross-department read guard: without this, a client-supplied memberId (from the
    // on-behalf path's pathParameters) would be used to key the GSI1 query directly, letting
    // any officer with ViewAttendanceOnBehalf read any member's attendance history in any
    // department. See PR #320 review, CRITICAL finding #1.
    const exists = await memberExists(client, tableName, deptId, memberId);
    if (!exists) {
      return notFoundProblem(traceId, 'Member was not found');
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: {
          ':gsi1pk': `MEMBER#${memberId}`,
          ':prefix': 'ATTENDANCE_RECORD#',
        },
        ScanIndexForward: true,
      }),
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: result.Items ?? [] }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logQueryFailure(reason, error, traceId);
    return serviceUnavailableProblem(traceId);
  }
}

async function queryOwnAttendance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  return queryAttendanceFor(event, toVerifiedDeptId(principal), principal.sub);
}

async function queryAttendanceOnBehalf(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return notFoundProblem(extractTraceId(event), 'memberId path parameter is required');
  }
  return queryAttendanceFor(event, toVerifiedDeptId(principal), memberId);
}

export const handler = withAuthorization(queryOwnAttendance, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnAttendance',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});

export const onBehalfHandler = withAuthorization(queryAttendanceOnBehalf, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewAttendanceOnBehalf',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
