import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { emitIncidentMetric, problemResponse, resolveTraceId } from './authContext.js';
import { getDocumentClient, getTableName } from './repository.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getNerisApiSchemaDocument } from './schemaVersion/s3Schema.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import { incidentTypeLabel, moduleSubschema } from './neris/apiSchema.js';

/** The NERIS modules the incident page edits with schema-driven editors. */
export const EDITABLE_MODULES = [
  'smoke_alarm',
  'fire_alarm',
  'other_alarm',
  'fire_suppression',
  'cooking_fire_suppression',
] as const;
export type EditableModule = (typeof EDITABLE_MODULES)[number];

export function isEditableModule(value: unknown): value is EditableModule {
  return typeof value === 'string' && (EDITABLE_MODULES as readonly string[]).includes(value);
}

/**
 * GET /api/v1/incidents/neris-schema — what the web picker and module editors render from:
 * the NERIS incident types (TypeIncidentValue, with readable labels) and the sub-schema of
 * each editable module, taken from the NERIS OpenAPI document the daily refresh compiled.
 * The server validates edits against these same nodes, so the two cannot drift.
 */
async function inner(event: GuardEvent): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  try {
    const bucket = process.env.NERIS_SCHEMA_BUCKET_NAME;
    const active = await createSchemaVersionRepository(
      getDocumentClient(),
      getTableName(process.env),
    ).getActiveSchemaVersion();
    if (!bucket || !active?.nerisApiS3Key) {
      return problemResponse(
        503,
        'Service Unavailable',
        "The NERIS schema hasn't been downloaded yet. It refreshes daily; try again later.",
        traceId,
        { code: 'NERIS_SCHEMA_UNAVAILABLE' },
      );
    }
    const schema = await getNerisApiSchemaDocument(getS3Client(), bucket, active.nerisApiS3Key);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
      body: JSON.stringify({
        version: active.version,
        apiVersion: schema.apiVersion,
        incidentTypes: schema.incidentTypes.map((value) => ({
          value,
          label: incidentTypeLabel(value),
        })),
        modules: Object.fromEntries(
          EDITABLE_MODULES.flatMap((module) => {
            const sub = moduleSubschema(schema, module);
            return sub ? [[module, sub]] : [];
          }),
        ),
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.nerisSchema.failed',
        correlationId: traceId,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('NerisSchemaReadFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to read the NERIS schema.', traceId);
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewNerisSchema',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
