import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';

export interface AttendanceTableConfig {
  readonly tableName: string;
}

export function readAttendanceTableConfig(env: NodeJS.ProcessEnv): AttendanceTableConfig {
  const tableName = env.PLATFORM_SERVICE_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_SERVICE_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readAttendanceTableConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}
