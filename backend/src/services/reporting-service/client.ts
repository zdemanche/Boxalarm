import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface GrantsReportConfig {
  readonly personnelTableName: string;
  readonly trainingTableName: string;
  readonly platformTableName: string;
}

export function readGrantsReportConfig(env: NodeJS.ProcessEnv): GrantsReportConfig {
  const personnelTableName = env.PERSONNEL_TABLE_NAME;
  if (!personnelTableName) {
    throw new Error('PERSONNEL_TABLE_NAME is required and was not set');
  }
  const trainingTableName = env.TRAINING_DYNAMO_TABLE_NAME;
  if (!trainingTableName) {
    throw new Error('TRAINING_DYNAMO_TABLE_NAME is required and was not set');
  }
  const platformTableName = env.PLATFORM_TABLE_NAME;
  if (!platformTableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { personnelTableName, trainingTableName, platformTableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readGrantsReportConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
