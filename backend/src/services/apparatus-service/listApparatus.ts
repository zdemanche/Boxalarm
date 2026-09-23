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
        event: 'apparatus.list.denied',
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

  try {
    const repository = getApparatusRepository(process.env);
    const apparatus = await repository.listApparatus(deptId);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apparatus }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.list.failed',
        correlationId: traceId,
        deptId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitApparatusMetric('ApparatusListFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to read the apparatus registry.',
      traceId,
    );
  }
};
