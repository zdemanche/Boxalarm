import type { APIGatewayProxyStructuredResultV2, Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readMemberServiceConfig } from '../config.js';

let cachedClient: DynamoDBDocumentClient | undefined;

function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}

export function createLivenessHandler(): Handler<unknown, APIGatewayProxyStructuredResultV2> {
  return () =>
    Promise.resolve({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'alive' }),
    });
}

export const livenessHandler = createLivenessHandler();

export function createReadinessHandler(
  deps: { client?: DynamoDBDocumentClient } = {},
): Handler<unknown, APIGatewayProxyStructuredResultV2> {
  return async () => {
    try {
      const config = readMemberServiceConfig(process.env);
      const client = getDocClient(deps.client);
      await client.send(
        new GetCommand({
          TableName: config.tableName,
          Key: {
            pk: buildDeptScopedPk(toVerifiedDeptId({ deptId: 'HEALTHCHECK' }), 'HEALTH'),
            sk: 'METADATA',
          },
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
          event: 'personnel.health.readiness.failed',
          service: 'personnel-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        }),
      );
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'not_ready' }),
      };
    }
  };
}

export const readinessHandler = createReadinessHandler();
