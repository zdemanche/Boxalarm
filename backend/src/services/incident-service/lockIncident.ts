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
import { loadReportContext, nerisApiFromEnv } from './reportContext.js';
import { runValidation } from './nerisValidation.js';
import { ReviewConflictError, lockIncident } from './reviewRepository.js';
import { readIncidentIdParam, readJsonObject } from './routeInput.js';

/**
 * POST /api/v1/incidents/{incidentId}/lock — officer review sign-off.
 *
 * Re-runs the full validation (local rules, department rules, and NERIS's own /validate
 * when the department is registered) and refuses with 409 plus the blocking list if anything
 * blocks. A NERIS outage is a warning, never a block: an officer can always lock. On success
 * every edit route answers 409 until an admin or chief unlocks. When the department setting
 * autoSubmitOnLock is on (and submissions are enabled) the NERIS submission is queued in the
 * same transaction; otherwise the report is VALIDATED and ready for POST .../submit.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const incidentId = readIncidentIdParam(event, traceId);
  if (typeof incidentId !== 'string') return incidentId;
  const parsed = readJsonObject(event, traceId, { optional: true });
  if (!parsed.ok) return parsed.problem;
  if (parsed.body.attest !== undefined && parsed.body.attest !== true) {
    return problemResponse(400, 'Bad Request', 'attest must be true when provided.', traceId);
  }

  try {
    const context = await loadReportContext(deptId, incidentId);
    if (!context) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }
    if (context.incident.lockedAt !== undefined) {
      return problemResponse(409, 'Conflict', 'This report is already locked.', traceId, {
        code: 'ALREADY_LOCKED',
      });
    }
    const report = await runValidation({
      ...context,
      mode: 'both',
      api: nerisApiFromEnv,
      nowEpochSeconds: nowEpochSeconds(),
    });
    if (report.blocking.length > 0) {
      emitIncidentMetric('IncidentLockBlocked');
      return problemResponse(
        409,
        'Conflict',
        `The report can't be locked yet: ${report.blocking.length} item${report.blocking.length === 1 ? '' : 's'} to fix.`,
        traceId,
        { code: 'VALIDATION_BLOCKED', ...report },
      );
    }

    const submit =
      context.settings.autoSubmitOnLock &&
      context.settings.submissionsEnabled &&
      context.settings.departmentNerisId !== undefined;
    const lockedAt = nowEpochSeconds();
    const result = await lockIncident(getDocumentClient(), getTableName(process.env), {
      deptId,
      incidentId,
      actorId: principal.sub,
      reviewedUpdatedAt: context.incident.updatedAt,
      previousStatus: context.incident.status,
      submit,
      nowEpochSeconds: lockedAt,
      traceId,
    });
    emitIncidentMetric(submit ? 'IncidentLockedAndSubmitted' : 'IncidentLocked');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId,
        lockedAt,
        lockedBy: principal.sub,
        status: result.status,
        submission: submit ? { status: 'QUEUED' } : null,
        nerisValidatedAt: report.nerisValidatedAt,
        warnings: report.warnings,
      }),
    };
  } catch (error) {
    if (error instanceof ReviewConflictError) {
      switch (error.conflict) {
        case 'NOT_FOUND':
          return problemResponse(
            404,
            'Not Found',
            `No incident found with incidentId "${incidentId}".`,
            traceId,
          );
        case 'SUBMISSION_IN_FLIGHT':
          return problemResponse(
            409,
            'Conflict',
            'A NERIS submission for this report is in progress. Lock it once the submission finishes.',
            traceId,
            { code: 'SUBMISSION_IN_FLIGHT' },
          );
        case 'ALREADY_LOCKED':
          return problemResponse(409, 'Conflict', 'This report is already locked.', traceId, {
            code: 'ALREADY_LOCKED',
          });
        default:
          return problemResponse(
            409,
            'Conflict',
            'The report changed while it was being reviewed. Check it again, then lock.',
            traceId,
            { code: 'CHANGED_SINCE_REVIEW' },
          );
      }
    }
    console.error(
      JSON.stringify({
        event: 'incident.lock.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('IncidentLockFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to lock the report.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'LockIncidentReport',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
