import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface PersonnelTableConfig {
  readonly tableName: string;
}

export function readPersonnelTableConfig(env: NodeJS.ProcessEnv): PersonnelTableConfig {
  const tableName = env.PERSONNEL_TABLE_NAME;
  if (!tableName) {
    throw new Error('PERSONNEL_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readPersonnelTableConfig(env);
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}
