import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { IncidentEvent } from './authContext.js';
import {
  emitIncidentMetric,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { IncidentNotFoundError, getDocumentClient, getTableName } from './repository.js';
import { upsertResponseUnitTimes, type ResponseUnitTimesInput } from './responseUnitRepository.js';

class ValidationError extends Error {}

const UNIT_TYPES = ['APPARATUS', 'MEMBER'] as const;
const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${key} must be a finite number`);
  }
  return value;
}

function parseInput(event: IncidentEvent): Omit<ResponseUnitTimesInput, 'deptId' | 'incidentId'> {
  if (!event.body) {
    throw new ValidationError('request body is required');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('request body must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  const unitId = record.unitId;
  if (typeof unitId !== 'string' || unitId.trim().length === 0) {
    throw new ValidationError('unitId is required and must be a non-empty string');
  }
  assertNoDelimiter(unitId, 'unitId');

  const unitType = record.unitType;
  if (typeof unitType !== 'string' || !(UNIT_TYPES as readonly string[]).includes(unitType)) {
    throw new ValidationError(`unitType must be one of: ${UNIT_TYPES.join(', ')}`);
  }

  const times: Partial<Record<(typeof TIME_FIELDS)[number], number>> = {};
  for (const field of TIME_FIELDS) {
    const value = optionalNumber(record, field);
    if (value !== undefined) {
      times[field] = value;
    }
  }

  return { unitId, unitType: unitType as 'APPARATUS' | 'MEMBER', times };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId;
  try {
    ({ deptId } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.responseTimes.denied',
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

  const incidentId = event.pathParameters?.incidentId;
  if (!incidentId) {
    return problemResponse(400, 'Bad Request', 'incidentId path parameter is required.', traceId);
  }
  try {
    assertNoDelimiter(incidentId, 'incidentId');
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof Error ? error.message : 'incidentId path parameter is invalid.',
      traceId,
    );
  }

  let input: Omit<ResponseUnitTimesInput, 'deptId' | 'incidentId'>;
  try {
    input = parseInput(event);
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid request body',
      traceId,
    );
  }

  try {
    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const unit = await upsertResponseUnitTimes(
      client,
      tableName,
      { deptId, incidentId, ...input },
      traceId,
    );
    emitIncidentMetric('IncidentResponseTimesUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(unit),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.responseTimes.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentResponseTimesFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to record response times.', traceId);
  }
};
