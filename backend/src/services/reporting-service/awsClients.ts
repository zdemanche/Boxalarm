import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface ReportingServiceConfig {
  readonly tableName: string;
}

export function readReportingServiceConfig(env: NodeJS.ProcessEnv): ReportingServiceConfig {
  const tableName = env.PLATFORM_SERVICE_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_SERVICE_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function createDynamoDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (!cachedDocClient) {
    cachedDocClient =
      client ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  }
  return cachedDocClient;
}
