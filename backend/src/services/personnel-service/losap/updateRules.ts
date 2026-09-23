import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireAdminRole } from '../lib/authz.js';
import { logError, logInfo } from '../lib/logger.js';
import { ACTIVITY_TYPES } from '../attendance/handler.js';
import { isValidLosapPointRules, type LosapPointRules } from './rules.js';
import {
  getLosapPointRules,
  putLosapPointRules,
  LosapConfigConflictError,
} from './configRepository.js';

function parseRulesBody(body: string | undefined): LosapPointRules | undefined {
  let raw: unknown;
  try {
    raw = body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const pointsByActivityType = (raw as Record<string, unknown>).pointsByActivityType;
  return isValidLosapPointRules(pointsByActivityType, ACTIVITY_TYPES)
    ? pointsByActivityType
    : undefined;
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  try {
    requireAdminRole(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logError('losap.rules.update.forbidden', traceId, error, { actorId: ctx.sub });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }

  const pointsByActivityType = parseRulesBody(event.body);
  if (!pointsByActivityType) {
    return problemResponse(
      400,
      'Bad Request',
      `pointsByActivityType must map at least one of ${ACTIVITY_TYPES.join(', ')} to a non-negative number`,
      traceId,
    );
  }

  try {
    const deptId = toVerifiedDeptId(ctx);
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
    const current = await getLosapPointRules(client, tableName, deptId);
    const result = await putLosapPointRules(
      client,
      tableName,
      deptId,
      pointsByActivityType,
      current?.version,
      ctx.sub,
      current?.pointsByActivityType,
    );
    logInfo('losap.rules.updated', traceId, { deptId, ruleVersionId: result.ruleVersionId });
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleVersionId: result.ruleVersionId, pointsByActivityType }),
    };
  } catch (error) {
    if (error instanceof LosapConfigConflictError) {
      logError('losap.rules.update.conflict', traceId, error);
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    logError('losap.rules.update.failed', traceId, error);
    return problemResponse(
      503,
      'Service Unavailable',
      'unable to update LOSAP point rules',
      traceId,
    );
  }
};
