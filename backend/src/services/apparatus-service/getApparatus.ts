import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import {
  emitApparatusMetric,
  getTraceId,
  problemResponse,
  readAuthorizerContext,
} from './authContext.js';
import { getApparatusRepository } from './apparatusRepository.js';

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = getTraceId(process.env);

  let deptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.get.denied',
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    return problemResponse(
      401,
      'Unauthorized',
      'A valid department-scoped authorization context is required.',
      traceId,
    );
  }

  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return problemResponse(400, 'Bad Request', 'unitId path parameter is required.', traceId);
  }

  try {
    const repository = getApparatusRepository(process.env);
    const apparatus = await repository.getApparatusDetail(deptId, unitId);
    if (!apparatus) {
      return problemResponse(
        404,
        'Not Found',
        `No apparatus found with unitId "${unitId}".`,
        traceId,
      );
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apparatus),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.get.failed',
        correlationId: traceId,
        deptId,
        unitId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitApparatusMetric('ApparatusReadFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read the apparatus record.',
      traceId,
    );
  }
};
