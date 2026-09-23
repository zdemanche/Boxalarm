import { randomUUID } from 'node:crypto';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getRawClient, readInventoryConfig } from '../../lib/dynamoDb.js';
import { logEvent } from '../../lib/logger.js';

export async function handler(
  _event: APIGatewayProxyEventV2,
  _context: unknown = undefined,
  _callback: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  client?: DynamoDBClient,
): Promise<APIGatewayProxyStructuredResultV2> {
  void _context;
  void _callback;
  try {
    const { tableName } = readInventoryConfig(env);
    const dynamoClient = getRawClient(client);
    await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ready' }),
    };
  } catch (error) {
    logEvent('error', {
      event: 'inventory.health.readiness.failed',
      correlationId: randomUUID(),
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'not-ready' }),
    };
  }
}
