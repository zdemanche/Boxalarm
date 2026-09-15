import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  withAuthorization,
  serviceUnavailableProblem,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { extractTraceId } from './handler.js';

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

async function queryOwnAttendance(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = principal.sub;

  try {
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
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

export const handler = withAuthorization(queryOwnAttendance, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewOwnAttendance',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
