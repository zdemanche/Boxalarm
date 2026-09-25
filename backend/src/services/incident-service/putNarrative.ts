import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { IncidentEvent } from './authContext.js';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import {
  IncidentNotFoundError,
  NarrativeTooLongError,
  getIncidentRepository,
} from './repository.js';

class ValidationError extends Error {}

function parseNarrative(event: IncidentEvent): string {
  if (!event.body) {
    throw new ValidationError('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('request body must be a JSON object');
  }
  const narrative = (parsed as Record<string, unknown>).narrative;
  if (typeof narrative !== 'string') {
    throw new ValidationError('narrative is required and must be a string');
  }
  return narrative;
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
        event: 'incident.narrative.denied',
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

  const incidentId = event.pathParameters?.incidentId;
  if (!incidentId) {
    return problemResponse(400, 'Bad Request', 'incidentId path parameter is required.', traceId);
  }
  try {
    assertNoDelimiter(incidentId, 'incidentId');
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof Error ? error.message : 'incidentId path parameter is invalid.',
      traceId,
    );
  }

  let narrative: string;
  try {
    narrative = parseNarrative(event);
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid request body',
      traceId,
    );
  }

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.updateNarrative(
      deptId,
      incidentId,
      narrative,
      nowEpochSeconds(),
      traceId,
    );
    emitIncidentMetric('IncidentNarrativeUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incident),
    };
  } catch (error) {
    if (error instanceof NarrativeTooLongError) {
      return problemResponse(400, 'Bad Request', error.message, traceId);
    }
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.narrative.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentNarrativeUpdateFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to update the incident narrative.',
      traceId,
    );
  }
};
