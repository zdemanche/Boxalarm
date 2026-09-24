import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitIncidentMetric,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { getIncidentRepository } from './repository.js';

class ValidationError extends Error {}

function parseEpochSeconds(value: string | undefined, field: string): number {
  if (value === undefined) {
    throw new ValidationError(`${field} query parameter is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} query parameter must be a finite number`);
  }
  return parsed;
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.search.denied',
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return problemResponse(
      401,
      'Unauthorized',
      'A valid department-scoped authorization context is required.',
      traceId,
    );
  }

  let fromAlarmAt: number;
  let toAlarmAt: number;
  try {
    fromAlarmAt = parseEpochSeconds(event.queryStringParameters?.fromAlarmAt, 'fromAlarmAt');
    toAlarmAt = parseEpochSeconds(event.queryStringParameters?.toAlarmAt, 'toAlarmAt');
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid query parameters',
      traceId,
    );
  }
  if (fromAlarmAt > toAlarmAt) {
    return problemResponse(
      400,
      'Bad Request',
      'fromAlarmAt must not be greater than toAlarmAt',
      traceId,
    );
  }

  try {
    const repository = getIncidentRepository(process.env);
    const incidents = await repository.searchIncidents(deptId, { fromAlarmAt, toAlarmAt });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidents }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.search.failed',
        correlationId: traceId,
        deptId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSearchFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to search incidents.', traceId);
  }
};
