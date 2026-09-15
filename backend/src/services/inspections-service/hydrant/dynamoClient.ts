import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface HydrantTableConfig {
  readonly tableName: string;
}

export function readHydrantTableConfig(env: NodeJS.ProcessEnv): HydrantTableConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedDocumentClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  cachedDocumentClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocumentClient;
}
