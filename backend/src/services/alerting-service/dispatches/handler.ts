import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  authorizeManualDispatchSubmission,
  getVerifiedPermissionsClient,
  readAuthorizationConfig,
} from './authorization.js';
import { deriveIngressIdempotencyKey, normalizeManualEntry } from './dispatchIngressPort.js';
import { getDynamoClient, readDispatchesConfig } from './dynamoClient.js';
import { problemResponse } from './errorResponse.js';
import { logError } from './logger.js';
import { createManualDispatch } from './repository.js';
import { runFanOut } from '../fanout/fanOut.js';
import { getSchedulerClient } from '../escalation/scheduleEscalation.js';

interface DispatchAuthorizerContext {
  readonly sub: string;
  readonly deptId: string;
  readonly 'cognito:groups': string;
}

type DispatchEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<DispatchAuthorizerContext>;

function emitIngressMetric(outcome: 'Accepted' | 'Rejected', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Alerting',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `DispatchIngress${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`DispatchIngress${outcome}`]: 1,
    }),
  );
}

function extractBearerToken(event: DispatchEvent): string | undefined {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

function parseJsonBody(event: DispatchEvent): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logError('dispatches.body.invalidJson', error, {
      traceId: event.requestContext.requestId,
    });
    return undefined;
  }
}

export const handler: Handler<DispatchEvent, APIGatewayProxyStructuredResultV2> = async (event) => {
  const traceId = event.requestContext.requestId;

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId(event.requestContext.authorizer.lambda);
  } catch (error) {
    logError('dispatches.unauthenticated', error, { traceId });
    emitIngressMetric('Rejected', 'MissingAuthorizerContext');
    return problemResponse({ status: 401, title: 'Unauthorized', traceId });
  }

  const token = extractBearerToken(event);
  if (!token) {
    emitIngressMetric('Rejected', 'MissingBearerToken');
    return problemResponse({ status: 401, title: 'Unauthorized', traceId });
  }

  let authConfig: ReturnType<typeof readAuthorizationConfig>;
  try {
    authConfig = readAuthorizationConfig(process.env);
  } catch (error) {
    logError('dispatches.config.invalid', error, { traceId });
    emitIngressMetric('Rejected', 'ConfigError');
    return problemResponse({ status: 503, title: 'Service unavailable', traceId });
  }

  const authOutcome = await authorizeManualDispatchSubmission(
    getVerifiedPermissionsClient(),
    authConfig,
    token,
    { traceId, deptId },
  );
  if (authOutcome === 'UNAVAILABLE') {
    emitIngressMetric('Rejected', 'AuthorizationUnavailable');
    return problemResponse({ status: 503, title: 'Authorization service unavailable', traceId });
  }
  if (authOutcome === 'DENIED') {
    emitIngressMetric('Rejected', 'Forbidden');
    return problemResponse({ status: 403, title: 'Forbidden', traceId });
  }

  const normalized = normalizeManualEntry(parseJsonBody(event));
  if (!normalized.ok) {
    emitIngressMetric('Rejected', 'ValidationFailed');
    return problemResponse({
      status: 400,
      title: 'Invalid dispatch payload',
      traceId,
      errors: normalized.errors,
    });
  }

  let dynamoConfig: ReturnType<typeof readDispatchesConfig>;
  try {
    dynamoConfig = readDispatchesConfig(process.env);
  } catch (error) {
    logError('dispatches.config.invalid', error, { traceId });
    emitIngressMetric('Rejected', 'ConfigError');
    return problemResponse({ status: 503, title: 'Service unavailable', traceId });
  }

  const idempotencyKey = deriveIngressIdempotencyKey(
    deptId,
    normalized.value.sourceSystem,
    normalized.value.externalDispatchId,
  );

  try {
    const result = await createManualDispatch(getDynamoClient(), dynamoConfig.tableName, {
      deptId,
      dispatch: normalized.value,
      idempotencyKey,
      dispatchedAt: Math.floor(Date.now() / 1000),
    });

    if (result.outcome === 'duplicate') {
      emitIngressMetric('Rejected', 'DuplicateSubmission');
      return problemResponse({ status: 409, title: 'Duplicate dispatch submission', traceId });
    }

    try {
      await runFanOut(
        getDynamoClient(),
        getSchedulerClient(),
        dynamoConfig.tableName,
        deptId,
        result.dispatchId,
        Math.floor(Date.now() / 1000),
      );
    } catch (error) {
      logError('dispatches.fanout.failed', error, {
        traceId,
        deptId,
        dispatchId: result.dispatchId,
      });
    }

    emitIngressMetric('Accepted');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId: result.dispatchId,
        sourceSystem: normalized.value.sourceSystem,
      }),
    };
  } catch (error) {
    logError('dispatches.create.unavailable', error, { traceId, deptId });
    emitIngressMetric('Rejected', 'DynamoUnavailable');
    return problemResponse({ status: 503, title: 'Service unavailable', traceId });
  }
};
