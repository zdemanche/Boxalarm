import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireAdminRole } from '../lib/authz.js';
import { getMember, updateMemberStatus } from '../lib/memberRepository.js';
import { SETTABLE_STATUSES, isValidStatusTransition } from '../lib/statusTransitions.js';
import type { SettableStatus } from '../lib/statusTransitions.js';
import { logError, logInfo } from '../lib/logger.js';

function parseStatusBody(body: string | undefined): SettableStatus {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : undefined;
  } catch {
    throw new Error('request body must be valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('request body must be a JSON object');
  }
  const status = (raw as Record<string, unknown>).status;
  if (typeof status !== 'string' || status.trim().length === 0) {
    throw new Error('status is required and must be a non-empty string');
  }
  if (!SETTABLE_STATUSES.includes(status as SettableStatus)) {
    throw new Error(`status must be one of: ${SETTABLE_STATUSES.join(', ')}`);
  }
  return status as SettableStatus;
}

function emitStatusChangeMetric(newStatus: SettableStatus): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel',
            Dimensions: [[], ['NewStatus']],
            Metrics: [{ Name: 'MemberStatusUpdated', Unit: 'Count' }],
          },
        ],
      },
      NewStatus: newStatus,
      MemberStatusUpdated: 1,
    }),
  );
}

interface TransactionCancellationReason {
  readonly Code?: string;
}

function isConditionalCheckFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return false;
  }
  const reasons = (error as { CancellationReasons?: readonly TransactionCancellationReason[] })
    .CancellationReasons;
  return (reasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed');
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return problemResponse(400, 'Bad Request', 'memberId path parameter is required', traceId);
  }

  try {
    requireAdminRole(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logError('member.status.update.forbidden', traceId, error, {
        actorId: ctx.sub,
        memberId,
        route: 'PUT /members/{memberId}/status',
      });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }

  let newStatus: SettableStatus;
  try {
    newStatus = parseStatusBody(event.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid status';
    return problemResponse(400, 'Bad Request', detail, traceId);
  }

  try {
    const config = readPersonnelConfig(process.env);
    const member = await getMember(config.tableName, ctx, memberId);
    if (!member) {
      return problemResponse(404, 'Not Found', `no member found with id ${memberId}`, traceId);
    }
    if (!isValidStatusTransition(member.status, newStatus)) {
      return problemResponse(
        409,
        'Conflict',
        `cannot transition member status from ${member.status} to ${newStatus}`,
        traceId,
      );
    }

    await updateMemberStatus(config.tableName, ctx, memberId, member.status, newStatus, ctx.sub);
    emitStatusChangeMetric(newStatus);
    logInfo('member.status.updated', traceId, { memberId });
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, status: newStatus }),
    };
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      logError('member.status.update.conflict', traceId, error, { memberId, newStatus });
      return problemResponse(
        409,
        'Conflict',
        'member status changed concurrently; retry with the latest status',
        traceId,
      );
    }
    logError('member.status.update.failed', traceId, error, { memberId, newStatus });
    return problemResponse(503, 'Service Unavailable', 'unable to update member status', traceId);
  }
};
