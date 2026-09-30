import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  conflictProblem,
  extractTraceId,
  forbiddenProblem,
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
  readonly clientAnswerId?: string;
  readonly answeredAtMs?: number;
}

/** An ETA is an arrival time: not long past (clock skew), not more than a day ahead. */
const MAX_ETA_PAST_SECONDS = 60 * 60;
const MAX_ETA_AHEAD_SECONDS = 24 * 60 * 60;

const CLIENT_ANSWER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** An answer queued offline is still ordered by when it was given - within reason. */
const MAX_ANSWER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The client's answer id: `clientAnswerId` in the body, or the standard `Idempotency-Key`
 * header. Both present must agree.
 */
function parseClientAnswerId(
  bodyValue: unknown,
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  const headerValue = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  )?.[1];
  for (const value of [bodyValue, headerValue]) {
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !CLIENT_ANSWER_ID_PATTERN.test(value)) {
        throw new Error(
          'clientAnswerId / Idempotency-Key must be 1-128 characters of letters, digits, ".", "_", ":" or "-"',
        );
      }
    }
  }
  if (
    typeof bodyValue === 'string' &&
    typeof headerValue === 'string' &&
    bodyValue !== headerValue
  ) {
    throw new Error('clientAnswerId and the Idempotency-Key header disagree');
  }
  return (typeof bodyValue === 'string' ? bodyValue : undefined) ?? headerValue ?? undefined;
}

/**
 * When the member answered, in epoch ms, as the client reports it; bounded by the server's
 * clock (a device clock running ahead cannot pin an answer in the future and block the
 * member's own later corrections).
 */
function parseAnsweredAtMs(value: unknown, receivedAtMs: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('answeredAtMs, if present, must be epoch milliseconds');
  }
  if (value < receivedAtMs - MAX_ANSWER_AGE_MS) {
    throw new Error('answeredAtMs is more than 24 hours old');
  }
  return Math.min(value, receivedAtMs);
}

function parseBody(
  raw: string | undefined,
  headers: Record<string, string | undefined> | undefined,
  receivedAtMs: number,
): RecordResponseBody {
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

  // ETA is optional (F1.6 asks for it; the data model's `eta` is nullable). A RESPONDING or
  // DIRECT_TO_SCENE answer without one is recorded with eta null and shown as unknown - never
  // rejected: a 400 here would drop the one signal that someone is coming, e.g. from a
  // lock-screen action that has no ETA to give. A provided value must still be valid.
  // The unit is the expected ARRIVAL TIME in epoch seconds - what the app sends
  // (now + minutes * 60) and renders (review MINOR-5). A small number is a duration in
  // minutes from a client that has the unit wrong; it is refused rather than shown as 1970.
  const eta = body.eta;
  if (ackStatus === 'NOT_RESPONDING') {
    if (eta !== undefined && eta !== null) {
      throw new Error('eta must not be provided when ackStatus is NOT_RESPONDING');
    }
  } else if (
    eta !== undefined &&
    eta !== null &&
    (typeof eta !== 'number' ||
      !Number.isInteger(eta) ||
      eta < Math.floor(receivedAtMs / 1000) - MAX_ETA_PAST_SECONDS ||
      eta > Math.floor(receivedAtMs / 1000) + MAX_ETA_AHEAD_SECONDS)
  ) {
    throw new Error(
      'eta, if provided, must be the expected arrival time in epoch seconds, within the next 24 hours',
    );
  }

  const assignedApparatusId = body.assignedApparatusId;
  if (
    assignedApparatusId !== undefined &&
    assignedApparatusId !== null &&
    (typeof assignedApparatusId !== 'string' || assignedApparatusId.length === 0)
  ) {
    throw new Error('assignedApparatusId, if present, must be a non-empty string');
  }

  const clientAnswerId = parseClientAnswerId(body.clientAnswerId, headers);
  const answeredAtMs = parseAnsweredAtMs(body.answeredAtMs, receivedAtMs);

  return {
    ackStatus: ackStatus as ResponseAckStatus,
    eta: ackStatus === 'NOT_RESPONDING' ? null : (eta ?? null),
    assignedApparatusId: (assignedApparatusId as string | undefined) ?? null,
    ...(clientAnswerId !== undefined ? { clientAnswerId } : {}),
    ...(answeredAtMs !== undefined ? { answeredAtMs } : {}),
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

  const receivedAtMs = Date.now();
  let body: RecordResponseBody;
  try {
    body = parseBody(event.body, event.headers, receivedAtMs);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  try {
    const config = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    const answeredAtMs = body.answeredAtMs ?? receivedAtMs;
    const result = await recordResponse(client, config.tableName, {
      deptId,
      dispatchId,
      memberId,
      ackStatus: body.ackStatus,
      eta: body.eta,
      assignedApparatusId: body.assignedApparatusId,
      answeredAt: Math.floor(answeredAtMs / 1000),
      answeredAtMs,
      receivedAtMs,
      ...(body.clientAnswerId !== undefined ? { clientAnswerId: body.clientAnswerId } : {}),
    });

    if (result.outcome === 'dispatch-not-found') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmRejected', 'DispatchNotFound');
      return notFoundProblem(traceId, 'Dispatch was not found');
    }

    if (result.outcome === 'ineligible') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmRejected', 'Ineligible');
      return forbiddenProblem(traceId);
    }

    if (result.outcome === 'answer-id-conflict') {
      emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmRejected', 'AnswerIdReused');
      return conflictProblem(
        traceId,
        'This clientAnswerId was already used for a different answer.',
        'ANSWER_ID_REUSED',
      );
    }

    if (result.roster === 'SUPERSEDED') {
      // Recorded in the audit trail, but a later answer is on the live roster: telling the
      // member "you responded" here would show them an answer the officers cannot see.
      emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmSuperseded');
      return conflictProblem(
        traceId,
        'Your answer was recorded, but a later answer is your current response on the roster.',
        'SUPERSEDED',
      );
    }

    emitOutcomeMetric(
      METRIC_NAMESPACE,
      result.replayed ? 'ResponseConfirmReplayed' : 'ResponseConfirmed',
    );
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        ...(result.replayed ? { 'idempotent-replayed': 'true' } : {}),
      },
      body: JSON.stringify({
        dispatchId,
        memberId,
        ackStatus: result.answer.ackStatus,
        eta: result.answer.eta,
        assignedApparatusId: result.answer.assignedApparatusId,
        answeredAt: result.answer.answeredAt,
        ...(body.clientAnswerId !== undefined ? { clientAnswerId: body.clientAnswerId } : {}),
      }),
    };
  } catch (error) {
    logError('responses.record.unavailable', error, { deptId, dispatchId, memberId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'ResponseConfirmFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(innerHandler, {
  actionType: 'Boxalarm::Action',
  actionId: 'RecordResponse',
  resourceType: 'Boxalarm::Dispatch',
  resourceId: (event) => event.pathParameters?.dispatchId ?? '',
});
