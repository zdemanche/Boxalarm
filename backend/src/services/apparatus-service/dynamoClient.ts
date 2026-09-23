import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export const GSI3_INDEX_NAME = 'GSI3';

export interface ApparatusTableConfig {
  readonly tableName: string;
}

export type ApparatusServiceConfig = ApparatusTableConfig;

export function readApparatusTableConfig(env: NodeJS.ProcessEnv): ApparatusTableConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

export function readApparatusServiceConfig(env: NodeJS.ProcessEnv): ApparatusServiceConfig {
  return readApparatusTableConfig(env);
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readApparatusTableConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
