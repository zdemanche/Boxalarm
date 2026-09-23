import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocumentClient, readInspectionsConfig } from './dynamoClient.js';

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const livenessHandler = (): Promise<APIGatewayProxyResultV2> =>
  Promise.resolve(jsonResponse(200, { status: 'ok' }));

export const readinessHandler = async (): Promise<APIGatewayProxyResultV2> => {
  try {
    const { tableName } = readInspectionsConfig(process.env);
    const client = getDocumentClient();
    await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :healthCheckPk',
        ExpressionAttributeValues: { ':healthCheckPk': 'HEALTHCHECK' },
        Limit: 1,
      }),
    );
    return jsonResponse(200, { status: 'ok' });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inspections.readiness.failed',
        service: 'inspections-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse(503, { status: 'unavailable' });
  }
};
