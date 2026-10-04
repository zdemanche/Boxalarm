import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  resolveTraceId,
} from './authContext.js';
import { getNerisDeptSettings, sendingBlocked } from './nerisSettings.js';
import { IncidentNotFoundError, getDocumentClient, getTableName } from './repository.js';
import { SubmissionRetryConflictError, getSubmissionRepository } from './submissionRepository.js';

async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);

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
    // The department kill switch is a deliberate setting: refuse clearly here rather than
    // queue a send the worker could only fail (inbox items to officers, NotConfigured alarm).
    const blocked = sendingBlocked(
      await getNerisDeptSettings(getDocumentClient(), getTableName(process.env), deptId),
    );
    if (blocked) {
      return problemResponse(409, 'Conflict', blocked.message, traceId, { code: blocked.code });
    }
    const repository = getSubmissionRepository(process.env);
    const result = await repository.retrySubmission(deptId, incidentId, nowEpochSeconds(), traceId);
    emitIncidentMetric('IncidentSubmissionRetryEnqueued');
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, submissionStatus: result.submissionStatus }),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    if (error instanceof SubmissionRetryConflictError) {
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.submission.retry.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentSubmissionRetryFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to retry the NERIS submission.',
      traceId,
    );
  }
}

/** Security-web MINOR 2: a declared Cedar action (NERIS officer tier), not a groups check. */
export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'RetryIncidentSubmission',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
