import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { ApparatusEvent } from './authContext.js';
import {
  emitApparatusMetric,
  getTraceId,
  problemResponse,
  readAuthorizerContext,
} from './authContext.js';
import { DuplicateApparatusError, getApparatusRepository } from './apparatusRepository.js';
import type { ApparatusStatus, CreateApparatusInput } from './apparatusRepository.js';

class ValidationError extends Error {}

const VALID_STATUSES: readonly ApparatusStatus[] = ['IN_SERVICE', 'OUT_OF_SERVICE'];

function parseJsonBody(event: ApparatusEvent): unknown {
  if (!event.body) {
    throw new ValidationError('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

function parseCreateApparatusInput(body: unknown): CreateApparatusInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const rawUnitId = record.unitId;
  if (typeof rawUnitId !== 'string' || rawUnitId.trim().length === 0) {
    throw new ValidationError('unitId is required and must be a non-empty string');
  }
  const unitId = rawUnitId.trim();
  if (unitId.includes('#')) {
    throw new ValidationError("unitId cannot contain '#'");
  }

  const type = record.type;
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new ValidationError('type is required and must be a non-empty string');
  }

  const rawStatus = record.status;
  if (rawStatus === undefined) {
    return { unitId, type, status: 'IN_SERVICE' };
  }
  if (typeof rawStatus !== 'string' || !VALID_STATUSES.includes(rawStatus as ApparatusStatus)) {
    throw new ValidationError('status must be one of IN_SERVICE, OUT_OF_SERVICE');
  }
  return { unitId, type, status: rawStatus as ApparatusStatus };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = getTraceId(process.env);

  let deptId, isAdmin;
  try {
    ({ deptId, isAdmin } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatus.create.denied',
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

  if (!isAdmin) {
    return problemResponse(
      403,
      'Forbidden',
      'Creating an apparatus record requires an admin or chief role.',
      traceId,
    );
  }

  let input: CreateApparatusInput;
  try {
    input = parseCreateApparatusInput(parseJsonBody(event));
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid request body',
      traceId,
    );
  }

  try {
    const repository = getApparatusRepository(process.env);
    const apparatus = await repository.createApparatus(deptId, input);
    emitApparatusMetric('ApparatusCreated');
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apparatus),
    };
  } catch (error) {
    if (error instanceof DuplicateApparatusError) {
      console.error(
        JSON.stringify({
          event: 'apparatus.create.conflict',
          correlationId: traceId,
          deptId,
          unitId: input.unitId,
          message: error.message,
        }),
      );
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'apparatus.create.failed',
        correlationId: traceId,
        deptId,
        unitId: input.unitId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitApparatusMetric('ApparatusCreateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to create apparatus.', traceId);
  }
};
