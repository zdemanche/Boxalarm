import type { Handler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GSI3_INDEX_NAME, getDocumentClient, getTableName } from './apparatusRepository.js';
import { getTraceId } from './authContext.js';

export interface HealthResult {
  readonly statusCode: number;
  readonly headers: { readonly 'Content-Type': string };
  readonly body: string;
}

export const livenessHandler: Handler<unknown, HealthResult> = () =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });

export const readinessHandler: Handler<unknown, HealthResult> = async () => {
  const correlationId = getTraceId(process.env);
  try {
    const tableName = getTableName(process.env);
    const client = getDocumentClient();
    await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI3_INDEX_NAME,
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': 'HEALTHCHECK#READINESS' },
        Limit: 1,
      }),
    );
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.readiness.failed',
        correlationId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'unavailable' }),
    };
  }
};
