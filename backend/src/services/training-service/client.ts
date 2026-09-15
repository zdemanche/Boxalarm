import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import type { GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';

export interface TrainingConfig {
  readonly tableName: string;
}

export function readTrainingConfig(env: NodeJS.ProcessEnv): TrainingConfig {
  const tableName = env.TRAINING_TABLE_NAME;
  if (!tableName) {
    throw new Error('TRAINING_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDocumentClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readTrainingConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export interface TrainingPrincipal {
  readonly sub: string;
  readonly deptId: VerifiedDeptId;
}

export function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

export function extractBearerToken(event: GuardEvent): string | undefined {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token;
}

export function resolveTrainingPrincipal(event: GuardEvent): TrainingPrincipal | undefined {
  const raw = event.requestContext.authorizer?.lambda;
  if (!raw || typeof raw.sub !== 'string' || raw.sub.length === 0 || !raw.deptId) {
    return undefined;
  }
  try {
    return { sub: raw.sub, deptId: toVerifiedDeptId({ deptId: raw.deptId }) };
  } catch (error) {
    logError('training.principal.invalid', error, { deptIdClaim: raw.deptId });
    return undefined;
  }
}

export function logError(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      ...context,
    }),
  );
}

export function logInfo(event: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...context }));
}

export function logDenied(
  event: string,
  reason: string,
  traceId: string,
  context: Record<string, unknown> = {},
): void {
  console.error(JSON.stringify({ event, reason, traceId, ...context }));
}

export function emitTrainingMetric(metricName: string, reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Training',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: metricName, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [metricName]: 1,
    }),
  );
}
