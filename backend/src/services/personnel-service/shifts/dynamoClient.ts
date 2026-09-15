import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';

export interface PersonnelTableConfig {
  readonly tableName: string;
}

export function readPersonnelTableConfig(env: NodeJS.ProcessEnv): PersonnelTableConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getDocClient(env: NodeJS.ProcessEnv): DynamoDBDocumentClient {
  readPersonnelTableConfig(env);
  cachedDocClient ??= DynamoDBDocumentClient.from(
    AWSXRay.captureAWSv3Client(new DynamoDBClient({})),
  );
  return cachedDocClient;
}
