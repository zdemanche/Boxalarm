import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { Incident } from './entity.js';
import { getDocumentClient, getIncidentRepository, getTableName } from './repository.js';
import { getNerisDeptSettings, type NerisDeptSettings } from './nerisSettings.js';
import { queryIncidentResponseUnits } from './dispatchProjection.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getCoreSchemaDocument, getNerisApiSchemaDocument } from './schemaVersion/s3Schema.js';
import type { CompiledNerisSchema } from './neris/apiSchema.js';
import type { NerisSchemaDocument } from './schemaVersion/entity.js';
import { getS3Client } from '../platform-service/export/awsClients.js';
import type { ResponseUnitRow } from './neris/payload.js';
import { createNerisApi, type NerisApi } from './neris/api.js';
import { getNerisClient, readNerisConfig } from './neris/index.js';

/** Everything the validation, lock and resubmission routes judge a report on. */
export interface ReportContext {
  readonly incident: Incident;
  readonly settings: NerisDeptSettings;
  readonly units: readonly ResponseUnitRow[];
  readonly schema?: NerisSchemaDocument;
  /** The compiled NERIS payload schema (incident types, module sub-schemas). */
  readonly nerisApi?: CompiledNerisSchema;
}

/**
 * The schema pin the report was authored under (same rule as updateIncident.ts), falling
 * back to ACTIVE; undefined when none is published or no bucket is configured, in which case
 * only the structural and department rules run.
 */
async function loadSchema(
  incident: Incident,
): Promise<{ schema?: NerisSchemaDocument; nerisApi?: CompiledNerisSchema }> {
  const bucket = process.env.NERIS_SCHEMA_BUCKET_NAME;
  if (!bucket) {
    return {};
  }
  const repository = createSchemaVersionRepository(getDocumentClient(), getTableName(process.env));
  const [pinned, active] = await Promise.all([
    repository.getSchemaVersion(incident.nerisSchemaVersion),
    repository.getActiveSchemaVersion(),
  ]);
  const version = pinned ?? active;
  // The NERIS payload schema follows the pin when the pin has one, else the ACTIVE version:
  // a report authored before the NERIS schema was downloaded still validates against it.
  const nerisApiKey = pinned?.nerisApiS3Key ?? active?.nerisApiS3Key;
  const [schema, nerisApi] = await Promise.all([
    version ? getCoreSchemaDocument(getS3Client(), bucket, version.coreSchemaS3Key) : undefined,
    nerisApiKey ? getNerisApiSchemaDocument(getS3Client(), bucket, nerisApiKey) : undefined,
  ]);
  return { ...(schema ? { schema } : {}), ...(nerisApi ? { nerisApi } : {}) };
}

export async function loadReportContext(
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<ReportContext | undefined> {
  const incident = await getIncidentRepository(process.env).getIncident(deptId, incidentId);
  if (!incident) {
    return undefined;
  }
  const client = getDocumentClient();
  const tableName = getTableName(process.env);
  const [settings, units, schemas] = await Promise.all([
    getNerisDeptSettings(client, tableName, deptId),
    queryIncidentResponseUnits(client, tableName, deptId, incidentId),
    loadSchema(incident),
  ]);
  return {
    incident,
    settings,
    units: units as unknown as ResponseUnitRow[],
    ...schemas,
  };
}

/** Lazily built so a local-only check never reads NERIS credentials. */
export async function nerisApiFromEnv(): Promise<NerisApi> {
  return createNerisApi(getNerisClient(await readNerisConfig(process.env)));
}
