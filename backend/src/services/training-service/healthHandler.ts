import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient, logError, readTrainingConfig } from './client.js';

export const livenessHandler = (): Promise<APIGatewayProxyResultV2> =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });

export function createReadinessHandler(client?: DynamoDBDocumentClient) {
  return async (): Promise<APIGatewayProxyResultV2> => {
    try {
      const config = readTrainingConfig(process.env);
      const documentClient = createDocumentClient(process.env, client);
      await documentClient.send(new DescribeTableCommand({ TableName: config.tableName }));
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok' }),
      };
    } catch (error) {
      logError('training.readiness.failed', error);
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'unavailable' }),
      };
    }
  };
}

export const readinessHandler = createReadinessHandler();
