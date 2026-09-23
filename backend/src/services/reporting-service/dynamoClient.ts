import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';

export interface PersonnelTableConfig {
  readonly tableName: string;
}

export interface AttendanceTableConfig {
  readonly tableName: string;
}

export function readPersonnelTableConfig(env: NodeJS.ProcessEnv): PersonnelTableConfig {
  const tableName = env.PERSONNEL_TABLE_NAME;
  if (!tableName) {
    throw new Error('PERSONNEL_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

export function readAttendanceTableConfig(env: NodeJS.ProcessEnv): AttendanceTableConfig {
  const tableName = env.PLATFORM_SERVICE_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_SERVICE_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedDocClient: DynamoDBDocumentClient | undefined;
let cachedRawClient: DynamoDBClient | undefined;

export function createDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readPersonnelTableConfig(env);
  readAttendanceTableConfig(env);
  if (client) {
    return client;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(
    AWSXRay.captureAWSv3Client(new DynamoDBClient({})),
  );
  return cachedDocClient;
}

export function createRawDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBClient,
): DynamoDBClient {
  readPersonnelTableConfig(env);
  readAttendanceTableConfig(env);
  if (client) {
    return client;
  }
  cachedRawClient ??= AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
  return cachedRawClient;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

function emit(
  sink: (line: string) => void,
  level: 'info' | 'error',
  event: string,
  correlationId: string,
  fields?: LogFields,
): void {
  sink(
    JSON.stringify({
      level,
      event,
      correlationId,
      service: 'reporting-service',
      ...fields,
    }),
  );
}

export function logInfo(event: string, correlationId: string, fields?: LogFields): void {
  emit(console.log, 'info', event, correlationId, fields);
}

export function logError(
  event: string,
  correlationId: string,
  error: unknown,
  fields?: LogFields,
): void {
  emit(console.error, 'error', event, correlationId, {
    message: error instanceof Error ? error.message : 'unknown error',
    originalError: error instanceof Error ? error.message : String(error),
    ...fields,
  });
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
