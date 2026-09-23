import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import * as AWSXRay from 'aws-xray-sdk-core';

export interface ApparatusConfig {
  readonly tableName: string;
}

export function readApparatusConfig(env: NodeJS.ProcessEnv): ApparatusConfig {
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
  readApparatusConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
