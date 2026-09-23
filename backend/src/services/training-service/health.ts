import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readTrainingDynamoConfig } from './dynamoClient.js';

function healthResponse(statusCode: number, status: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  };
}

export function livenessHandler(): Promise<APIGatewayProxyResultV2> {
  return Promise.resolve(healthResponse(200, 'ok'));
}

export async function readinessHandler(): Promise<APIGatewayProxyResultV2> {
  try {
    const { tableName } = readTrainingDynamoConfig(process.env);
    const client = createDynamoClient();
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return healthResponse(200, 'ok');
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'training.readiness.failed',
        service: 'training',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      }),
    );
    return healthResponse(503, 'unavailable');
  }
}
