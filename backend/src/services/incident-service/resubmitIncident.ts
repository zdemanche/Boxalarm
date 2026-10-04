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
import { loadReportContext } from './reportContext.js';
import { buildNerisIncidentPayload, diffPayloads } from './neris/payload.js';
import {
  ReviewConflictError,
  enqueueResubmission,
  getLastAcceptedPayload,
} from './reviewRepository.js';
import { readIncidentIdParam } from './routeInput.js';

/**
 * POST /api/v1/incidents/{incidentId}/resubmit — send a corrected report to NERIS.
 *
 * NERIS already holds the record (it has a NERIS id), so the worker replaces it with
 * PUT /incident/{entity}/{neris id} rather than creating a second one. The response carries
 * the field-level diff against the payload NERIS last accepted; an unchanged report is not
 * resent. The report must be locked again (reviewed) first.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const incidentId = readIncidentIdParam(event, traceId);
  if (typeof incidentId !== 'string') return incidentId;

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
    const { incident, settings } = context;
    if (!incident.nerisIncidentId) {
      return problemResponse(
        409,
        'Conflict',
        "NERIS doesn't have this report yet. Lock it and submit it first.",
        traceId,
        { code: 'NOT_IN_NERIS' },
      );
    }
    if (incident.lockedAt === undefined) {
      return problemResponse(
        409,
        'Conflict',
        'Lock the corrected report before resubmitting it.',
        traceId,
        {
          code: 'NOT_LOCKED',
        },
      );
    }
    if (!settings.departmentNerisId || !settings.submissionsEnabled) {
      return problemResponse(
        409,
        'Conflict',
        'NERIS submissions are not set up or are switched off for the department.',
        traceId,
        { code: 'NOT_CONFIGURED' },
      );
    }
    if (!context.nerisApi) {
      return problemResponse(
        409,
        'Conflict',
        "The NERIS schema hasn't been downloaded yet, so nothing can be sent. It refreshes daily.",
        traceId,
        { code: 'NOT_CONFIGURED' },
      );
    }
    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const previous = await getLastAcceptedPayload(client, tableName, deptId, incidentId);
    const current = buildNerisIncidentPayload({
      incident,
      units: context.units,
      departmentNerisId: settings.departmentNerisId,
      unitNerisIds: settings.unitNerisIds,
      schema: context.nerisApi,
    });
    const diff = diffPayloads(previous ?? {}, current);
    // A record NERIS no longer has (given up on by reconciliation) is re-sent even unchanged:
    // the worker creates it again (round 2b, R3).
    if (previous && diff.length === 0 && incident.nerisMissingAt === undefined) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId, diff, status: 'UNCHANGED' }),
      };
    }
    await enqueueResubmission(client, tableName, {
      deptId,
      incidentId,
      actorId: principal.sub,
      changeCount: diff.length,
      nowEpochSeconds: nowEpochSeconds(),
      traceId,
    });
    emitIncidentMetric('IncidentResubmitEnqueued');
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentId,
        nerisIncidentId: incident.nerisIncidentId,
        diff,
        status: 'QUEUED',
        submissionStatus: 'SUBMITTED',
      }),
    };
  } catch (error) {
    if (error instanceof ReviewConflictError) {
      const detail: Record<string, string> = {
        NOT_FOUND: `No incident found with incidentId "${incidentId}".`,
        NOT_LOCKED: 'Lock the corrected report before resubmitting it.',
        NOT_IN_NERIS: "NERIS doesn't have this report yet. Lock it and submit it first.",
      };
      return error.conflict === 'NOT_FOUND'
        ? problemResponse(404, 'Not Found', detail.NOT_FOUND!, traceId)
        : problemResponse(
            409,
            'Conflict',
            detail[error.conflict] ?? 'A NERIS submission for this report is already in progress.',
            traceId,
            { code: error.conflict },
          );
    }
    console.error(
      JSON.stringify({
        event: 'incident.resubmit.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('IncidentResubmitFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to resubmit the report.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ResubmitIncidentReport',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
