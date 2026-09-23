import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { withAuthorization } from '@boxalarm/authz';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { HydrantNotFoundError, updateHydrant } from './hydrantRepository.js';
import type { UpdateHydrantInput } from './hydrantRepository.js';
import { HYDRANT_ID_PATTERN, isValidCalendarDate } from './hydrantKeys.js';
import type { HydrantStatus } from './hydrantKeys.js';
import { problemResponse } from './httpProblem.js';
import { logError } from './logger.js';

// See createHydrantHandler.ts for why this uses real Cedar authorization (E8-S3, merged)
// instead of the interim TODO(E8-S3) any-non-empty-groups stopgap. Unlike create, the
// hydrant being updated already exists, so its path-parameter id is the natural resourceId.
const UPDATE_HYDRANT_ACTION = {
  actionType: 'Boxalarm::Action',
  actionId: 'UpdateHydrant',
  resourceType: 'Boxalarm::Hydrant',
} as const;

const VALID_STATUSES: readonly HydrantStatus[] = ['IN_SERVICE', 'OUT_OF_SERVICE'];

function extractTraceId(traceparent: string | undefined): string {
  const segment = traceparent?.split('-')[1];
  return segment && segment.length > 0 ? segment : randomUUID();
}

function emitMetric(outcome: 'HydrantUpdated' | 'HydrantWriteFailed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/inspections',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

function validateUpdateInput(body: unknown): UpdateHydrantInput | string {
  if (typeof body !== 'object' || body === null) {
    return 'request body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  const result: { status?: HydrantStatus; lastFlowTestDate?: string; nextFlowTestDue?: string } =
    {};

  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !VALID_STATUSES.includes(b.status as HydrantStatus)) {
      return 'status must be one of IN_SERVICE, OUT_OF_SERVICE';
    }
    result.status = b.status as HydrantStatus;
  }
  if (b.lastFlowTestDate !== undefined) {
    if (typeof b.lastFlowTestDate !== 'string' || !isValidCalendarDate(b.lastFlowTestDate)) {
      return 'lastFlowTestDate must be a valid calendar ISO date (YYYY-MM-DD)';
    }
    result.lastFlowTestDate = b.lastFlowTestDate;
  }
  if (b.nextFlowTestDue !== undefined) {
    if (typeof b.nextFlowTestDue !== 'string' || !isValidCalendarDate(b.nextFlowTestDue)) {
      return 'nextFlowTestDue must be a valid calendar ISO date (YYYY-MM-DD)';
    }
    result.nextFlowTestDue = b.nextFlowTestDue;
  }

  if (Object.keys(result).length === 0) {
    return 'at least one of status, lastFlowTestDate, nextFlowTestDue is required';
  }
  if (
    result.lastFlowTestDate !== undefined &&
    result.nextFlowTestDue !== undefined &&
    result.nextFlowTestDue < result.lastFlowTestDate
  ) {
    return 'nextFlowTestDue must not be before lastFlowTestDate';
  }
  return result;
}

function parseUpdateBody(rawBody: string | undefined): UpdateHydrantInput | string {
  if (!rawBody) {
    return 'request body is required';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return 'request body must be valid JSON';
  }
  return validateUpdateInput(parsed);
}

export async function updateHydrantInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const traceId = extractTraceId(event.headers?.traceparent);
  const correlationId = traceId;

  const hydrantId = event.pathParameters?.hydrantId;
  if (!hydrantId || !HYDRANT_ID_PATTERN.test(hydrantId)) {
    emitMetric('HydrantWriteFailed', 'InvalidHydrantId');
    logError({
      event: 'hydrant.update.denied',
      correlationId,
      service: 'inspections-service',
      deptId: principal.deptId,
      reason: 'InvalidHydrantId',
    });
    return problemResponse(
      400,
      'Invalid hydrant update',
      'hydrantId path parameter is required and must match ^[A-Za-z0-9_-]{1,64}$',
      traceId,
    );
  }

  const validated = parseUpdateBody(event.body);
  if (typeof validated === 'string') {
    emitMetric('HydrantWriteFailed', 'InvalidBody');
    logError({
      event: 'hydrant.update.denied',
      correlationId,
      service: 'inspections-service',
      deptId: principal.deptId,
      reason: 'InvalidBody',
      detail: validated,
    });
    return problemResponse(400, 'Invalid hydrant update', validated, traceId);
  }

  const deptId = toVerifiedDeptId(principal);

  try {
    const hydrant = await updateHydrant(deptId, hydrantId, validated, correlationId);
    emitMetric('HydrantUpdated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hydrant),
    };
  } catch (error) {
    const reason = error instanceof HydrantNotFoundError ? 'NotFound' : 'DynamoDbError';
    logError({
      event: 'hydrant.update.failed',
      correlationId,
      service: 'inspections-service',
      reason,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    emitMetric('HydrantWriteFailed', reason);
    if (error instanceof HydrantNotFoundError) {
      return problemResponse(404, 'Hydrant not found', error.message, traceId);
    }
    return problemResponse(
      503,
      'Hydrant service unavailable',
      'unable to persist hydrant update',
      traceId,
    );
  }
}

export const handler = withAuthorization(updateHydrantInner, {
  ...UPDATE_HYDRANT_ACTION,
  resourceId: (event) => event.pathParameters?.hydrantId ?? 'unknown',
});
