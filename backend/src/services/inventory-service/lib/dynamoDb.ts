import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import xray from 'aws-xray-sdk-core';

export interface InventoryConfig {
  readonly tableName: string;
}

export function readInventoryConfig(env: NodeJS.ProcessEnv): InventoryConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedRawClient: DynamoDBClient | undefined;

export function getRawClient(client?: DynamoDBClient): DynamoDBClient {
  if (client) {
    return client;
  }
  cachedRawClient ??= xray.captureAWSv3Client(new DynamoDBClient({}));
  return cachedRawClient;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (client) {
    return client;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(getRawClient(), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cachedDocClient;
}
