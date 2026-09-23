import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { createDynamoClient, readAttendanceTableConfig } from '../dynamoClient.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { ForbiddenError, requireAdminRole } from '../lib/authz.js';
import { listMembers } from '../lib/memberRepository.js';
import { logError } from '../lib/logger.js';
import { getYearEndReport } from './repository.js';

function parseYear(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const year = Number(raw);
  return Number.isInteger(year) && year > 0 ? year : undefined;
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
      logError('losap.yearEnd.forbidden', traceId, error, { actorId: ctx.sub });
      return problemResponse(403, 'Forbidden', error.message, traceId);
    }
    throw error;
  }

  const year = parseYear(event.queryStringParameters?.year);
  if (year === undefined) {
    return problemResponse(
      400,
      'Bad Request',
      'year query parameter is required and must be a positive integer',
      traceId,
    );
  }

  try {
    const personnelConfig = readPersonnelConfig(process.env);
    const members = await listMembers(personnelConfig.tableName, ctx);
    const { tableName } = readAttendanceTableConfig(process.env);
    const client = createDynamoClient(process.env);
    const deptId = toVerifiedDeptId(ctx);
    const report = await getYearEndReport(
      client,
      tableName,
      deptId,
      members.map((member) => member.memberId),
      year,
    );
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ year, members: report }),
    };
  } catch (error) {
    logError('losap.yearEnd.failed', traceId, error, { year });
    return problemResponse(
      503,
      'Service Unavailable',
      'unable to generate the year-end LOSAP report',
      traceId,
    );
  }
};
