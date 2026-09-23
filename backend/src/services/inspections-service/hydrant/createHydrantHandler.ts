import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { withAuthorization } from '@boxalarm/authz';
import type { CedarPrincipalContext, GuardEvent } from '@boxalarm/authz';
import { createHydrant, HydrantAlreadyExistsError } from './hydrantRepository.js';
import type { CreateHydrantInput } from './hydrantRepository.js';
import { HYDRANT_ID_PATTERN, isValidCalendarDate } from './hydrantKeys.js';
import type { HydrantStatus } from './hydrantKeys.js';
import { problemResponse } from './httpProblem.js';
import { logError } from './logger.js';

// #77 / E5-S3 review: architecture.md marks hydrant writes officer-scoped
// (PUT is Cognito(admin)); a hand-rolled "any non-empty cognito:groups" check let any
// authenticated member create/mutate hydrant records. E8-S3's Cedar authorization
// (packages/authz, merged) is now available, so this uses the real IsAuthorizedWithToken
// call instead of the interim TODO(E8-S3) stopgap other stories in this batch still carry.
const CREATE_HYDRANT_ACTION = {
  actionType: 'Boxalarm::Action',
  actionId: 'CreateHydrant',
  resourceType: 'Boxalarm::Hydrant',
} as const;

const VALID_STATUSES: readonly HydrantStatus[] = ['IN_SERVICE', 'OUT_OF_SERVICE'];

function extractTraceId(traceparent: string | undefined): string {
  const segment = traceparent?.split('-')[1];
  return segment && segment.length > 0 ? segment : randomUUID();
}

function emitMetric(outcome: 'HydrantCreated' | 'HydrantWriteFailed', reason?: string): void {
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

function validateCreateInput(body: unknown): CreateHydrantInput | string {
  if (typeof body !== 'object' || body === null) {
    return 'request body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  if (typeof b.hydrantId !== 'string' || !HYDRANT_ID_PATTERN.test(b.hydrantId)) {
    return 'hydrantId is required and must match ^[A-Za-z0-9_-]{1,64}$';
  }
  if (typeof b.latitude !== 'number' || !Number.isFinite(b.latitude)) {
    return 'latitude is required and must be a finite number';
  }
  if (typeof b.longitude !== 'number' || !Number.isFinite(b.longitude)) {
    return 'longitude is required and must be a finite number';
  }
  if (typeof b.size !== 'string' || b.size.trim().length === 0) {
    return 'size is required and must be a non-empty string';
  }
  if (typeof b.flowRatingGpm !== 'number' || !Number.isFinite(b.flowRatingGpm)) {
    return 'flowRatingGpm is required and must be a finite number';
  }
  if (typeof b.nextFlowTestDue !== 'string' || !isValidCalendarDate(b.nextFlowTestDue)) {
    return 'nextFlowTestDue is required and must be a valid calendar ISO date (YYYY-MM-DD)';
  }
  const status = b.status === undefined ? 'IN_SERVICE' : b.status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as HydrantStatus)) {
    return 'status must be one of IN_SERVICE, OUT_OF_SERVICE';
  }
  return {
    hydrantId: b.hydrantId,
    latitude: b.latitude,
    longitude: b.longitude,
    size: b.size,
    flowRatingGpm: b.flowRatingGpm,
    nextFlowTestDue: b.nextFlowTestDue,
    status: status as HydrantStatus,
  };
}

function parseCreateBody(rawBody: string | undefined): CreateHydrantInput | string {
  if (!rawBody) {
    return 'request body is required';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return 'request body must be valid JSON';
  }
  return validateCreateInput(parsed);
}

export async function createHydrantInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyStructuredResultV2> {
  const traceId = extractTraceId(event.headers?.traceparent);
  const correlationId = traceId;

  const validated = parseCreateBody(event.body);
  if (typeof validated === 'string') {
    emitMetric('HydrantWriteFailed', 'InvalidBody');
    logError({
      event: 'hydrant.create.denied',
      correlationId,
      service: 'inspections-service',
      deptId: principal.deptId,
      reason: 'InvalidBody',
      detail: validated,
    });
    return problemResponse(400, 'Invalid hydrant payload', validated, traceId);
  }

  const deptId = toVerifiedDeptId(principal);

  try {
    const hydrant = await createHydrant(deptId, validated);
    emitMetric('HydrantCreated');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hydrant),
    };
  } catch (error) {
    const reason = error instanceof HydrantAlreadyExistsError ? 'AlreadyExists' : 'DynamoDbError';
    logError({
      event: 'hydrant.create.failed',
      correlationId,
      service: 'inspections-service',
      reason,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    emitMetric('HydrantWriteFailed', reason);
    if (error instanceof HydrantAlreadyExistsError) {
      return problemResponse(409, 'Hydrant already exists', error.message, traceId);
    }
    return problemResponse(
      503,
      'Hydrant service unavailable',
      'unable to persist hydrant record',
      traceId,
    );
  }
}

// resourceId is a fixed collection-level placeholder, not a per-hydrant identifier: the
// hydrant being created doesn't exist yet, so there is no natural resource id to check —
// the Cedar policy authorizes on principal role, not on a specific not-yet-created entity.
export const handler = withAuthorization(createHydrantInner, {
  ...CREATE_HYDRANT_ACTION,
  resourceId: () => 'hydrants',
});
