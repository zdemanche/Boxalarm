import type { APIGatewayProxyHandlerV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { getDocumentClient, readHydrantTableConfig } from '../hydrant/dynamoClient.js';
import { logError } from '../hydrant/logger.js';

export const livenessHandler: APIGatewayProxyHandlerV2 =
  (): Promise<APIGatewayProxyStructuredResultV2> =>
    Promise.resolve({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    });

export const readinessHandler: APIGatewayProxyHandlerV2 =
  async (): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      const { tableName } = readHydrantTableConfig(process.env);
      await getDocumentClient().send(new DescribeTableCommand({ TableName: tableName }));
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok' }),
      };
    } catch (error) {
      logError({
        event: 'inspections.readiness.failed',
        service: 'inspections-service',
        correlationId: 'n/a',
        message: error instanceof Error ? error.message : 'unknown error',
      });
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'unavailable' }),
      };
    }
  };
