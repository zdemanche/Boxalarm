import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { createDynamoClient, readApparatusConfig } from './client.js';
import { logError } from './repository.js';

export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  try {
    const config = readApparatusConfig(process.env);
    const client = createDynamoClient(process.env);
    await client.send(new DescribeTableCommand({ TableName: config.tableName }));
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (error) {
    logError('apparatus.readiness.failed', error);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unavailable' }),
    };
  }
};
