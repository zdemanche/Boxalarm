import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import type { APIGatewayProxyHandlerV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { readOccupancyServiceConfig } from '../occupancy/config.js';
import { logStructuredError } from '../occupancy/log.js';

let cachedClient: DynamoDBClient | undefined;

function getClient(): DynamoDBClient {
  cachedClient ??= captureAWSv3Client(new DynamoDBClient({}));
  return cachedClient;
}

function healthResponse(statusCode: number, status: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- handler contract is async; liveness has no dependency to await
export const livenessHandler: APIGatewayProxyHandlerV2 = async () => healthResponse(200, 'ok');

export const readinessHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const config = readOccupancyServiceConfig(process.env);
    await getClient().send(new DescribeTableCommand({ TableName: config.tableName }));
    return healthResponse(200, 'ok');
  } catch (error) {
    logStructuredError('inspections.readiness.failed', event.requestContext.requestId, {
      message: error instanceof Error ? error.message : undefined,
    });
    return healthResponse(503, 'unavailable');
  }
};
