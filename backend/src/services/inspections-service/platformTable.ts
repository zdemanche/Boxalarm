import xray from 'aws-xray-sdk-core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface InspectionsTableConfig {
  readonly tableName: string;
}

export function readInspectionsTableConfig(env: NodeJS.ProcessEnv): InspectionsTableConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readInspectionsTableConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(xray.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
