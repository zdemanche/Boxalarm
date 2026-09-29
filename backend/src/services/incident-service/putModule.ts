import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  resolveTraceId,
} from './authContext.js';
import { IncidentNotFoundError, getIncidentRepository } from './repository.js';
import { IncidentLockedError, lockedProblem } from './lock.js';
import { loadSchema } from './reportContext.js';
import { deepPick, moduleNode, validateNode } from './neris/apiSchema.js';
import { fieldLabel } from './nerisValidation.js';
import { isEditableModule } from './getNerisSchema.js';
import { readIncidentIdParam, readJsonObject } from './routeInput.js';

/**
 * PUT /api/v1/incidents/{incidentId}/modules/{module}  {value} — one NERIS module (smoke
 * alarm, fire alarm, other alarm, suppression, cooking suppression) as the web editor built
 * it from the same NERIS sub-schema (GET /incidents/neris-schema). The value is reduced to
 * what the sub-schema declares and must satisfy its required choices and allowed values;
 * locked reports refuse (409) and the write bumps contentVersion like every content edit.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const incidentId = readIncidentIdParam(event, traceId);
  if (typeof incidentId !== 'string') return incidentId;
  const module = event.pathParameters?.module;
  if (!isEditableModule(module)) {
    return problemResponse(
      400,
      'Bad Request',
      'module must be one of the editable NERIS modules.',
      traceId,
    );
  }
  const parsed = readJsonObject(event, traceId);
  if (!parsed.ok) return parsed.problem;

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.getIncident(deptId, incidentId);
    if (!incident) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }
    if (incident.lockedAt !== undefined) return lockedProblem(traceId);
    const { nerisApi } = await loadSchema(incident);
    const node = nerisApi ? moduleNode(nerisApi, module) : undefined;
    if (!nerisApi || !node) {
      return problemResponse(
        503,
        'Service Unavailable',
        "The NERIS schema hasn't been downloaded yet. It refreshes daily; try again later.",
        traceId,
        { code: 'NERIS_SCHEMA_UNAVAILABLE' },
      );
    }
    const value = deepPick(nerisApi, node, parsed.body.value);
    const problems =
      value === undefined
        ? [{ path: '', code: 'required' as const }]
        : validateNode(nerisApi, node, value);
    if (problems.length > 0) {
      return problemResponse(
        400,
        'Bad Request',
        `The ${fieldLabel(module).toLowerCase()} is not complete.`,
        traceId,
        {
          errors: problems.map((problem) => ({
            field: problem.path || module,
            message:
              problem.code === 'required'
                ? 'is required'
                : problem.code === 'enum'
                  ? `must be one of: ${(problem.allowed ?? []).join(', ')}`
                  : 'has the wrong type',
          })),
        },
      );
    }
    const updated = await repository.updateModule(
      deptId,
      incidentId,
      module,
      value as Record<string, unknown>,
      nowEpochSeconds(),
      traceId,
    );
    emitIncidentMetric('IncidentModuleUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    };
  } catch (error) {
    if (error instanceof IncidentLockedError) return lockedProblem(traceId);
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.module.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        module,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('IncidentModuleUpdateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to save the module.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'EditIncidentModule',
  resourceType: 'Boxalarm::Incident',
  resourceId: (event) => event.pathParameters?.incidentId ?? '',
});
