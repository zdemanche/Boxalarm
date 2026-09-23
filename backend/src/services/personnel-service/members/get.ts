import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { getMember } from '../lib/memberRepository.js';
import { logError } from '../lib/logger.js';

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
    const config = readPersonnelConfig(process.env);
    const member = await getMember(config.tableName, ctx, memberId);
    if (!member) {
      return problemResponse(404, 'Not Found', `no member found with id ${memberId}`, traceId);
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(member),
    };
  } catch (error) {
    logError('member.get.failed', traceId, error, { memberId });
    return problemResponse(503, 'Service Unavailable', 'unable to retrieve member', traceId);
  }
};
