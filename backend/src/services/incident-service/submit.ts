import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { IncidentNotFoundError } from './repository.js';
import { SubmissionConflictError, getSubmissionRepository } from './submissionRepository.js';

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId, isAdmin;
  try {
    ({ deptId, isAdmin } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.submit.denied',
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

  if (!isAdmin) {
    return problemResponse(
      403,
      'Forbidden',
      'Submitting an incident to NERIS requires an admin or chief role.',
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
      error instanceof Error ? error.message : 'invalid incidentId',
      traceId,
    );
  }

  try {
    const repository = getSubmissionRepository(process.env);
    const result = await repository.enqueueSubmission(
      deptId,
      incidentId,
      nowEpochSeconds(),
      traceId,
    );
    emitIncidentMetric('IncidentSubmitEnqueued');
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, submissionStatus: result.submissionStatus }),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    if (error instanceof SubmissionConflictError) {
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.submit.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSubmitFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to submit incident to NERIS.',
      traceId,
    );
  }
};
