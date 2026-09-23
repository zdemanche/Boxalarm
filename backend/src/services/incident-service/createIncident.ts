import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { IncidentEvent } from './authContext.js';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import { isIncidentStatus, type CreateIncidentInput, type IncidentStatus } from './entity.js';
import { DuplicateIncidentError, getIncidentRepository } from './repository.js';

class ValidationError extends Error {}

// Leaves headroom under DynamoDB's 400 KB item limit for the rest of the INCIDENT item
// (keys, GSI attributes, NERIS metadata fields) so an oversized corePayload fails fast
// with a clear 400 instead of surfacing as an opaque 503 from the DynamoDB write.
const MAX_CORE_PAYLOAD_BYTES = 350_000;

function parseJsonBody(event: IncidentEvent): unknown {
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

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string`);
  }
  return value;
}

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

function parseCreateIncidentInput(body: unknown, createdBy: string): CreateIncidentInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const dispatchNumber = record.dispatchNumber;
  if (typeof dispatchNumber !== 'string' || dispatchNumber.trim().length === 0) {
    throw new ValidationError('dispatchNumber is required and must be a non-empty string');
  }
  if (dispatchNumber.includes('#')) {
    throw new ValidationError("dispatchNumber cannot contain '#'");
  }

  const epochSeconds = record.epochSeconds;
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
    throw new ValidationError('epochSeconds is required and must be a finite number');
  }

  const nerisSchemaVersion = record.nerisSchemaVersion;
  if (typeof nerisSchemaVersion !== 'string' || nerisSchemaVersion.trim().length === 0) {
    throw new ValidationError('nerisSchemaVersion is required and must be a non-empty string');
  }

  const corePayload = record.corePayload;
  if (typeof corePayload !== 'object' || corePayload === null || Array.isArray(corePayload)) {
    throw new ValidationError('corePayload is required and must be a JSON object');
  }
  const corePayloadBytes = Buffer.byteLength(JSON.stringify(corePayload), 'utf8');
  if (corePayloadBytes > MAX_CORE_PAYLOAD_BYTES) {
    throw new ValidationError(
      `corePayload must not exceed ${MAX_CORE_PAYLOAD_BYTES} bytes when serialized; received ${corePayloadBytes} bytes`,
    );
  }

  let status: IncidentStatus | undefined;
  if (record.status !== undefined) {
    if (!isIncidentStatus(record.status)) {
      throw new ValidationError(
        'status must be one of DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED',
      );
    }
    status = record.status;
  }

  const incidentType = optionalString(record, 'incidentType');
  const address = optionalString(record, 'address');
  const latitude = optionalNumber(record, 'latitude');
  const longitude = optionalNumber(record, 'longitude');
  const alarmAt = optionalNumber(record, 'alarmAt');
  const dispatchAt = optionalNumber(record, 'dispatchAt');
  const arrivedAt = optionalNumber(record, 'arrivedAt');
  const clearedAt = optionalNumber(record, 'clearedAt');
  const narrative = optionalString(record, 'narrative');

  return {
    dispatchNumber: dispatchNumber.trim(),
    epochSeconds,
    nerisSchemaVersion: nerisSchemaVersion.trim(),
    corePayload: corePayload as Readonly<Record<string, unknown>>,
    status: status ?? 'DRAFT',
    ...(incidentType !== undefined ? { incidentType } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(alarmAt !== undefined ? { alarmAt } : {}),
    ...(dispatchAt !== undefined ? { dispatchAt } : {}),
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
    ...(clearedAt !== undefined ? { clearedAt } : {}),
    ...(narrative !== undefined ? { narrative } : {}),
    createdBy,
  };
}

export const handler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<AuthorizerContext> = async (
  event,
) => {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);

  let deptId, isAdmin, sub;
  try {
    ({ deptId, isAdmin, sub } = readAuthorizerContext(event));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.create.denied',
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
      'Creating an incident record requires an admin or chief role.',
      traceId,
    );
  }

  let input: CreateIncidentInput;
  try {
    input = parseCreateIncidentInput(parseJsonBody(event), sub);
  } catch (error) {
    return problemResponse(
      400,
      'Bad Request',
      error instanceof ValidationError ? error.message : 'invalid request body',
      traceId,
    );
  }

  try {
    const repository = getIncidentRepository(process.env);
    const incident = await repository.createIncident(deptId, input, nowEpochSeconds(), traceId);
    emitIncidentMetric('IncidentCreated');
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incident),
    };
  } catch (error) {
    if (error instanceof DuplicateIncidentError) {
      console.error(
        JSON.stringify({
          event: 'incident.create.conflict',
          correlationId: traceId,
          deptId,
          dispatchNumber: input.dispatchNumber,
          message: error.message,
        }),
      );
      return problemResponse(409, 'Conflict', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.create.failed',
        correlationId: traceId,
        deptId,
        dispatchNumber: input.dispatchNumber,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentCreateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to create incident.', traceId);
  }
};
