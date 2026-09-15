import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { recordResponse, type ResponseAckStatus } from './repository.js';

const METRIC_NAMESPACE = 'Boxalarm/Alerting';
const RESPONSE_ACK_STATUSES: ReadonlySet<string> = new Set([
  'RESPONDING',
  'NOT_RESPONDING',
  'DIRECT_TO_SCENE',
]);

interface RecordResponseBody {
  readonly ackStatus: ResponseAckStatus;
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function parseBody(raw: string | undefined): RecordResponseBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;

  const ackStatus = body.ackStatus;
  if (typeof ackStatus !== 'string' || !RESPONSE_ACK_STATUSES.has(ackStatus)) {
    throw new Error(
      'ackStatus is required and must be one of RESPONDING, NOT_RESPONDING, DIRECT_TO_SCENE',
    );
  }

  const eta = body.eta;
  if (ackStatus === 'NOT_RESPONDING') {
    if (eta !== undefined && eta !== null) {
      throw new Error('eta must not be provided when ackStatus is NOT_RESPONDING');
    }
  } else if (typeof eta !== 'number' || !Number.isInteger(eta) || eta <= 0) {
    throw new Error('eta is required and must be a positive integer for this ackStatus');
  }

  const assignedApparatusId = body.assignedApparatusId;
  if (
    assignedApparatusId !== undefined &&
    assignedApparatusId !== null &&
    (typeof assignedApparatusId !== 'string' || assignedApparatusId.length === 0)
  ) {
    throw new Error('assignedApparatusId, if present, must be a non-empty string');
  }

  return {
    ackStatus: ackStatus as ResponseAckStatus,
    eta: ackStatus === 'NOT_RESPONDING' ? null : (eta as number),
    assignedApparatusId: (assignedApparatusId as string | undefined) ?? null,
  };
}

async function innerHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return notFoundProblem(traceId, 'dispatchId path parameter is required');
  }

  let body: RecordResponseBody;
  try {
    body = parseBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  try {
    const config = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const result = await recordResponse(client, config.tableName, {
      deptId,
      dispatchId,
      memberId,
      ackStatus: body.ackStatus,
      eta: body.eta,
      assignedApparatusId: body.assignedApparatusId,
      answeredAt: Date.now(),
    });

    if (result.outcome === 'dispatch-not-found') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmRejected', 'DispatchNotFound');
      return notFoundProblem(traceId, 'Dispatch was not found');
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId,
        memberId,
        ackStatus: body.ackStatus,
        eta: body.eta,
        assignedApparatusId: body.assignedApparatusId,
      }),
    };
  } catch (error) {
    logError('responses.record.unavailable', error, { deptId, dispatchId, memberId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerHandler, {
  actionType: 'AlertingService',
  actionId: 'RecordResponse',
  resourceType: 'Dispatch',
  resourceId: (event) => event.pathParameters?.dispatchId ?? '',
});
