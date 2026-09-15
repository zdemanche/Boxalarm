import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';

const HEALTHCHECK_DEPT_ID = toVerifiedDeptId({ deptId: 'HEALTHCHECK' });

export const liveness = (): Promise<APIGatewayProxyResultV2> =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'alive' }),
  });

export const readiness = async (): Promise<APIGatewayProxyResultV2> => {
  try {
    const client = createDynamoClient(process.env);
    const config = readAlertingConfig(process.env);
    await client.send(
      new GetCommand({
        TableName: config.tableName,
        Key: { pk: buildDeptScopedPk(HEALTHCHECK_DEPT_ID, 'HEALTHCHECK'), sk: 'HEALTHCHECK' },
      }),
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ready' }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'alerting.health.readiness.failed',
        service: 'alerting-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'not-ready' }),
    };
  }
};
