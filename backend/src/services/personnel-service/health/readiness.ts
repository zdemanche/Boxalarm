import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';

// A reserved, non-tenant deptId — the item is never expected to exist; this probe only
// proves read access to the table, so the dept-scoping gate (test/pk-scoping.test.ts,
// AC3 of E8-S7) still applies to a key that will never collide with real tenant data.
const READINESS_SENTINEL_KEY = {
  pk: buildDeptScopedPk(toVerifiedDeptId({ deptId: 'healthcheck' }), 'READINESS_PROBE'),
  sk: 'READINESS_PROBE',
};

export const handler: APIGatewayProxyHandlerV2 = async () => {
  try {
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
    await client.send(new GetCommand({ TableName: tableName, Key: READINESS_SENTINEL_KEY }));
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'personnel.readiness_failed',
        service: 'personnel-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        originalError: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unavailable' }),
    };
  }
};
