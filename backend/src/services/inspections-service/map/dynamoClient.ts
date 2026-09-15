import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface MapTableConfig {
  readonly tableName: string;
}

export function readMapTableConfig(env: NodeJS.ProcessEnv): MapTableConfig {
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
  readMapTableConfig(env);
  cachedClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedClient;
}
