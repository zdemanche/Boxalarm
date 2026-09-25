import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { assertNoDelimiter } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../platform-service/authorizer/handler.js';
import type { IncidentEvent } from './authContext.js';
import {
  emitIncidentMetric,
  nowEpochSeconds,
  problemResponse,
  readAuthorizerContext,
  resolveTraceId,
} from './authContext.js';
import {
  IncidentNotFoundError,
  getDocumentClient,
  getIncidentRepository,
  getTableName,
} from './repository.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getCoreSchemaDocument } from './schemaVersion/s3Schema.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import { missingRequiredCoreFields, validateCoreFields } from './schemaVersion/validateEnum.js';

class ValidationError extends Error {}

function parseFields(event: IncidentEvent): Record<string, string> {
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
  const fields = (parsed as Record<string, unknown>).fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new ValidationError('fields is required and must be a JSON object of field:value pairs');
  }
  const record = fields as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw new ValidationError(`field "${key}" must be a string`);
    }
    result[key] = value;
  }
  return result;
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
        event: 'incident.update.denied',
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

  let fields: Record<string, string>;
  try {
    fields = parseFields(event);
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
    const incident = await repository.getIncident(deptId, incidentId);
    if (!incident) {
      return problemResponse(
        404,
        'Not Found',
        `No incident found with incidentId "${incidentId}".`,
        traceId,
      );
    }

    const client = getDocumentClient();
    const tableName = getTableName(process.env);
    const schemaVersionRepository = createSchemaVersionRepository(client, tableName);
    // Validate against the schema version this incident was authored under, not whatever
    // is newest: the scheduled refresh job can promote a new ACTIVE schema at any time, and
    // re-validating an older incident against it would apply enum/requiredFields rules it was
    // never authored under. Falls back to ACTIVE only when the pinned version can't be
    // resolved at all (e.g. the 'UNVALIDATED' sentinel createIncident.ts's dispatch-linked
    // path uses when no schema was ACTIVE yet at create time).
    const schema =
      (await schemaVersionRepository.getSchemaVersion(incident.nerisSchemaVersion)) ??
      (await schemaVersionRepository.getActiveSchemaVersion());
    if (!schema) {
      return problemResponse(
        503,
        'Service Unavailable',
        'No active NERIS schema version is published.',
        traceId,
      );
    }
    const coreSchema = await getCoreSchemaDocument(
      getS3Client(),
      process.env.NERIS_SCHEMA_BUCKET_NAME ?? '',
      schema.coreSchemaS3Key,
    );

    const errors = validateCoreFields(coreSchema, fields);
    if (errors.length > 0) {
      return problemResponse(
        400,
        'Bad Request',
        'One or more fields failed NERIS enumeration validation.',
        traceId,
        { errors },
      );
    }

    const mergedFields = { ...incident.corePayload, ...fields } as Record<string, string>;
    const missing = missingRequiredCoreFields(coreSchema, mergedFields);
    const nextStatus = missing.length === 0 ? 'VALIDATED' : incident.status;

    const updated = await repository.updateCorePayload(
      deptId,
      incidentId,
      mergedFields,
      nextStatus,
      nowEpochSeconds(),
      traceId,
    );

    emitIncidentMetric('IncidentUpdated');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    };
  } catch (error) {
    if (error instanceof IncidentNotFoundError) {
      return problemResponse(404, 'Not Found', error.message, traceId);
    }
    console.error(
      JSON.stringify({
        event: 'incident.update.failed',
        correlationId: traceId,
        deptId,
        incidentId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('IncidentUpdateFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to update the incident.', traceId);
  }
};
