import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitIncidentMetric, problemResponse, resolveTraceId } from './authContext.js';
import { loadReportContext, nerisApiFromEnv } from './reportContext.js';
import { VALIDATION_MODES, runValidation, type ValidationMode } from './nerisValidation.js';
import { readIncidentIdParam, readJsonObject } from './routeInput.js';

/**
 * POST /api/v1/incidents/{incidentId}/validate  {mode: 'local' | 'neris' | 'both'}
 * -> {blocking, warnings, nerisValidatedAt, sectionsComplete}. Read-only: nothing is stored
 * and nothing is created in NERIS (its /validate endpoint answers 204 or 422, nothing more).
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
  const mode = parsed.body.mode ?? 'both';
  if (typeof mode !== 'string' || !(VALIDATION_MODES as readonly string[]).includes(mode)) {
    return problemResponse(400, 'Bad Request', 'mode must be one of local, neris, both.', traceId);
  }

  // The NERIS round trip uses the department's NERIS credentials and counts against its API
  // limits: members get the local checks; officers and up also ask NERIS (review minor 12).
  const groups = principal['cognito:groups'].split(' ');
  const mayAskNeris = groups.some((group) => ['OFFICER', 'CHIEF', 'ADMIN'].includes(group));
  const effectiveMode: ValidationMode = mayAskNeris ? (mode as ValidationMode) : 'local';

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
    const report = await runValidation({
      ...context,
      mode: effectiveMode,
      api: nerisApiFromEnv,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    });
    emitIncidentMetric(
      report.blocking.length === 0 ? 'IncidentValidationPassed' : 'IncidentValidationBlocked',
    );
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentId, mode: effectiveMode, ...report }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.validate.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('IncidentValidationFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to validate the report.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ValidateIncidentReport',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
