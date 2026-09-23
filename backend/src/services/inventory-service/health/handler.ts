import { randomUUID } from 'node:crypto';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import type { Handler } from 'aws-lambda';
import { serviceUnavailableProblem, type ProblemResponse } from '@boxalarm/authz';
import { readInventoryConfig } from '../lifecycle/repository.js';

let cachedClient: DynamoDBClient | undefined;

export function createHealthDynamoClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBClient,
): DynamoDBClient {
  readInventoryConfig(env);
  cachedClient ??= client ?? captureAWSv3Client(new DynamoDBClient({}));
  return cachedClient;
}

interface HealthResult {
  readonly statusCode: 200;
  readonly headers: { readonly 'content-type': 'application/json' };
  readonly body: string;
}

const OK: HealthResult = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'ok' }),
};

export const livenessHandler: Handler<never, HealthResult> = () => Promise.resolve(OK);

export function createReadinessHandler(
  dynamoClient?: DynamoDBClient,
): Handler<never, HealthResult | ProblemResponse> {
  return async () => {
    const traceId = randomUUID();
    try {
      const client = createHealthDynamoClient(process.env, dynamoClient);
      const config = readInventoryConfig(process.env);
      await client.send(new DescribeTableCommand({ TableName: config.tableName }));
      return OK;
    } catch (error) {
      const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error(
        JSON.stringify({
          event: 'inventory.readiness.failed',
          service: 'inventory',
          reason,
          correlationId: traceId,
        }),
      );
      return serviceUnavailableProblem(traceId);
    }
  };
}

export const readinessHandler = createReadinessHandler();
