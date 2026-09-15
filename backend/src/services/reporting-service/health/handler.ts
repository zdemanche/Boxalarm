import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Handler } from 'aws-lambda';
import AWSXRay from 'aws-xray-sdk-core';
import { readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';

let cachedClient: DynamoDBClient | undefined;

function getDescribeClient(): DynamoDBClient {
  cachedClient ??= AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
  return cachedClient;
}

function jsonResponse(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function handleReadiness(): Promise<APIGatewayProxyResultV2> {
  try {
    const { tableName } = readReportingServiceConfig(process.env);
    const client = getDescribeClient();
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return jsonResponse(200, { status: 'ok' });
  } catch (error) {
    logError('reporting.health.readiness.failed', error);
    return jsonResponse(503, { status: 'unavailable' });
  }
}

export const handler: Handler<APIGatewayProxyEventV2, APIGatewayProxyResultV2> = async (event) => {
  const path = event.rawPath;
  if (path.endsWith('/readiness')) {
    return handleReadiness();
  }
  return jsonResponse(200, { status: 'ok' });
};
