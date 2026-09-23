import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';
import { readPersonnelConfig } from '../lib/config.js';
import { problemResponse, resolveTraceId } from '../lib/problemDetails.js';
import { listMembers } from '../lib/memberRepository.js';
import { logError } from '../lib/logger.js';

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<VerifiedAccessToken> = async (
  event,
) => {
  const ctx = event.requestContext.authorizer.lambda;
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  try {
    const config = readPersonnelConfig(process.env);
    const members = await listMembers(config.tableName, ctx);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members }),
    };
  } catch (error) {
    logError('member.list.failed', traceId, error);
    return problemResponse(503, 'Service Unavailable', 'unable to list members', traceId);
  }
};
