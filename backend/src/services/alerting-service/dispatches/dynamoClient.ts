import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface DispatchesConfig {
  readonly tableName: string;
}

export function readDispatchesConfig(env: NodeJS.ProcessEnv): DispatchesConfig {
  const tableName = env.ALERTING_DISPATCHES_TABLE_NAME;
  if (!tableName) {
    throw new Error('ALERTING_DISPATCHES_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

function createDocumentClient(): DynamoDBDocumentClient {
  const tracedClient = captureAWSv3Client(new DynamoDBClient({}));
  return DynamoDBDocumentClient.from(tracedClient);
}

export function getDynamoClient(): DynamoDBDocumentClient {
  cachedClient ??= createDocumentClient();
  return cachedClient;
}
