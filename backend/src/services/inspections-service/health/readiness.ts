import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { readMapTableConfig } from '../map/dynamoClient.js';

export interface ReadinessDeps {
  readonly client?: DynamoDBClient;
}

export async function checkReadiness(
  env: NodeJS.ProcessEnv,
  deps: ReadinessDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const config = readMapTableConfig(env);
    const client = deps.client ?? new DynamoDBClient({});
    await client.send(new DescribeTableCommand({ TableName: config.tableName }));
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'inspections-health.readiness-failed',
        service: 'inspections-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unavailable' }),
    };
  }
}

export function createReadinessHandler(
  deps: ReadinessDeps = {},
): () => Promise<APIGatewayProxyResultV2> {
  return () => checkReadiness(process.env, deps);
}

export const handler = createReadinessHandler();
