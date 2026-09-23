import type { Handler } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readPlatformTableConfig } from '../inventory/config.js';
import { getDynamoDocumentClient } from '../inventory/dynamoClient.js';

export interface HealthResult {
  readonly statusCode: number;
  readonly body: string;
}

const READINESS_PK = buildDeptScopedPk(
  toVerifiedDeptId({ deptId: 'healthcheck' }),
  'APPARATUS',
  'readiness',
);

export const liveness: Handler<unknown, HealthResult> = () =>
  Promise.resolve({ statusCode: 200, body: JSON.stringify({ status: 'ok' }) });

export function createReadinessHandler(
  getClient: (
    override?: DynamoDBDocumentClient,
  ) => DynamoDBDocumentClient = getDynamoDocumentClient,
): Handler<unknown, HealthResult> {
  return async () => {
    try {
      const { tableName } = readPlatformTableConfig(process.env);
      const client = getClient();
      await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pkValue',
          ExpressionAttributeValues: { ':pkValue': READINESS_PK },
          Limit: 1,
        }),
      );
      return { statusCode: 200, body: JSON.stringify({ status: 'ok' }) };
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'apparatus.readiness.unavailable',
          service: 'apparatus-service',
          reason: error instanceof Error ? error.constructor.name : 'UnknownError',
          message: error instanceof Error ? error.message : undefined,
        }),
      );
      return { statusCode: 503, body: JSON.stringify({ status: 'unavailable' }) };
    }
  };
}

export const readiness = createReadinessHandler();
