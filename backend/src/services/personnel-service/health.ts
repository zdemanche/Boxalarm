import type { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readPersonnelConfig } from './lib/config.js';
import { logError } from './lib/logger.js';

let cachedDocClient: DynamoDBDocumentClient | undefined;

function getDocClient(): DynamoDBDocumentClient {
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

const HEALTH_PROBE_DEPT_ID = toVerifiedDeptId({ deptId: 'HEALTHCHECK' });

export const livenessHandler: Handler = () =>
  Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok' }),
  });

export const readinessHandler: Handler = async () => {
  try {
    const config = readPersonnelConfig(process.env);
    await getDocClient().send(
      new GetCommand({
        TableName: config.tableName,
        Key: { pk: buildDeptScopedPk(HEALTH_PROBE_DEPT_ID, 'HEALTH'), sk: 'PROBE' },
      }),
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (error) {
    logError('health.readiness.failed', 'health-probe', error);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unavailable' }),
    };
  }
};
