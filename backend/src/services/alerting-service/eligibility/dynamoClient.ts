import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';

export interface AlertingDdbConfig {
  readonly tableName: string;
}

export function readAlertingDdbConfig(env: NodeJS.ProcessEnv): AlertingDdbConfig {
  const tableName = env.ALERTING_TABLE_NAME;
  if (!tableName) {
    throw new Error('ALERTING_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDdbClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readAlertingDdbConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
