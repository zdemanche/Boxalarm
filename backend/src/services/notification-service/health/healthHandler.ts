import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';

function logError(event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

export const livenessHandler = (): Promise<APIGatewayProxyResultV2> =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });

export function createReadinessHandler(client?: DynamoDBDocumentClient) {
  return async (): Promise<APIGatewayProxyResultV2> => {
    try {
      const config = readNotificationConfig(process.env);
      const documentClient = client ?? createDynamoClient(process.env);
      await documentClient.send(new DescribeTableCommand({ TableName: config.tableName }));
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok' }),
      };
    } catch (error) {
      logError('notification.readiness.failed', error);
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'unavailable' }),
      };
    }
  };
}

export const readinessHandler = createReadinessHandler();
