import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { queryHydrantsDueWithin } from './hydrantRepository.js';
import { problemResponse } from './httpProblem.js';
import { logError } from './logger.js';

const YEAR_MONTH_PATTERN = /^\d{4}-\d{2}$/;

function extractTraceId(traceparent: string | undefined): string {
  const segment = traceparent?.split('-')[1];
  return segment && segment.length > 0 ? segment : randomUUID();
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const traceId = extractTraceId(event.headers.traceparent);
  const correlationId = traceId;
  const principal = event.requestContext.authorizer.lambda as AuthorizerContext | undefined;

  if (!principal?.deptId || !principal.sub) {
    logError({
      event: 'hydrant.list.denied',
      correlationId,
      service: 'inspections-service',
      reason: 'MissingAuthorizerContext',
    });
    return problemResponse(401, 'Unauthorized', 'request is missing a verified principal', traceId);
  }

  const dueBefore = event.queryStringParameters?.dueBefore;
  if (!dueBefore || !YEAR_MONTH_PATTERN.test(dueBefore)) {
    logError({
      event: 'hydrant.list.denied',
      correlationId,
      service: 'inspections-service',
      deptId: principal.deptId,
      reason: 'InvalidDueBefore',
    });
    return problemResponse(
      400,
      'Invalid hydrant list query',
      'dueBefore query parameter is required and must be YYYY-MM',
      traceId,
    );
  }

  const deptId = toVerifiedDeptId(principal);

  try {
    const hydrants = await queryHydrantsDueWithin(deptId, dueBefore);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hydrants }),
    };
  } catch (error) {
    logError({
      event: 'hydrant.list.failed',
      correlationId,
      service: 'inspections-service',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    return problemResponse(503, 'Hydrant service unavailable', 'unable to list hydrants', traceId);
  }
};
