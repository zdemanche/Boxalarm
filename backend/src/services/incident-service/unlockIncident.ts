import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  resolveTraceId,
} from './authContext.js';
import { getDocumentClient, getTableName } from './repository.js';
import { ReviewConflictError, unlockIncident } from './reviewRepository.js';
import { readIncidentIdParam, readJsonObject } from './routeInput.js';

export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 1_000;

/**
 * POST /api/v1/incidents/{incidentId}/unlock  {reason} — admin/chief only (Cedar), audited
 * with the reason. Refused while a NERIS submission is in flight: the worker may be reading
 * the record, and an edit mid-send would make the ledger lie about what NERIS received.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const incidentId = readIncidentIdParam(event, traceId);
  if (typeof incidentId !== 'string') return incidentId;
  const parsed = readJsonObject(event, traceId);
  if (!parsed.ok) return parsed.problem;
  const reason = typeof parsed.body.reason === 'string' ? parsed.body.reason.trim() : '';
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return problemResponse(
      400,
      'Bad Request',
      `reason is required: say why the report is being reopened (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters).`,
      traceId,
    );
  }

  try {
    const unlockedAt = nowEpochSeconds();
    await unlockIncident(getDocumentClient(), getTableName(process.env), {
      deptId,
      incidentId,
      actorId: principal.sub,
      reason,
      nowEpochSeconds: unlockedAt,
      traceId,
    });
    emitIncidentMetric('IncidentUnlocked');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, unlockedAt, unlockedBy: principal.sub, reason }),
    };
  } catch (error) {
    if (error instanceof ReviewConflictError) {
      if (error.conflict === 'NOT_FOUND') {
        return problemResponse(
          404,
          'Not Found',
          `No incident found with incidentId "${incidentId}".`,
          traceId,
        );
      }
      return error.conflict === 'NOT_LOCKED'
        ? problemResponse(409, 'Conflict', 'This report is not locked.', traceId, {
            code: 'NOT_LOCKED',
          })
        : problemResponse(
            409,
            'Conflict',
            'A NERIS submission for this report is in progress. Unlock it once the submission finishes.',
            traceId,
            { code: 'SUBMISSION_IN_FLIGHT' },
          );
    }
    console.error(
      JSON.stringify({
        event: 'incident.unlock.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('IncidentUnlockFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to unlock the report.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'UnlockIncidentReport',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
