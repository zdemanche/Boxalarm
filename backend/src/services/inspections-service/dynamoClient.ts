import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import xray from 'aws-xray-sdk-core';

export interface InspectionsConfig {
  readonly tableName: string;
}

export function readInspectionsConfig(env: NodeJS.ProcessEnv): InspectionsConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(xray.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
