import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

export interface PersonnelServiceConfig {
  readonly tableName: string;
  readonly busName: string;
}

export function readPersonnelServiceConfig(env: NodeJS.ProcessEnv): PersonnelServiceConfig {
  const tableName = env.PERSONNEL_TABLE_NAME;
  if (!tableName) {
    throw new Error('PERSONNEL_TABLE_NAME is required and was not set');
  }
  const busName = env.PLATFORM_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_BUS_NAME is required and was not set');
  }
  return { tableName, busName };
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function createDynamoDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (!cachedDocClient) {
    cachedDocClient =
      client ?? DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  }
  return cachedDocClient;
}

let cachedEventBridgeClient: EventBridgeClient | undefined;

export function createEventBridgeClient(client?: EventBridgeClient): EventBridgeClient {
  cachedEventBridgeClient ??= client ?? captureAWSv3Client(new EventBridgeClient({}));
  return cachedEventBridgeClient;
}
