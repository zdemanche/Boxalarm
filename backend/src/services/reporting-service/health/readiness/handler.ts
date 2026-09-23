import { randomUUID } from 'node:crypto';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  createRawDynamoClient,
  readAttendanceTableConfig,
  readPersonnelTableConfig,
  logError,
} from '../../dynamoClient.js';

export async function handler(
  _event: APIGatewayProxyEventV2,
  _context: unknown = undefined,
  _callback: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  client?: DynamoDBClient,
): Promise<APIGatewayProxyStructuredResultV2> {
  void _event;
  void _context;
  void _callback;
  try {
    const { tableName: personnelTable } = readPersonnelTableConfig(env);
    const { tableName: attendanceTable } = readAttendanceTableConfig(env);
    const dynamoClient = createRawDynamoClient(env, client);
    await Promise.all([
      dynamoClient.send(new DescribeTableCommand({ TableName: personnelTable })),
      dynamoClient.send(new DescribeTableCommand({ TableName: attendanceTable })),
    ]);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ready' }),
    };
  } catch (error) {
    logError('reporting.health.readiness.failed', randomUUID(), error);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'not-ready' }),
    };
  }
}
