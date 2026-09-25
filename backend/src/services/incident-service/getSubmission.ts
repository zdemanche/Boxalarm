import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitIncidentMetric,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { getSubmissionRepository } from './submissionRepository.js';

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId, canManageSubmission;
  try {
    ({ deptId, canManageSubmission } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.submission.get.denied',
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

  if (!canManageSubmission) {
    return problemResponse(
      403,
      'Forbidden',
      'Reading NERIS submission status requires an officer, admin, or chief role.',
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
    const record = await repository.getSubmission(deptId, incidentId);
    if (!record) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId: record.incidentId,
        status: record.status,
        submissionStatus: record.submissionStatus ?? null,
        ...(record.submissionFailureReason !== undefined
          ? { submissionFailureReason: record.submissionFailureReason }
          : {}),
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.submission.get.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSubmissionReadFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read NERIS submission status.',
      traceId,
    );
  }
};
