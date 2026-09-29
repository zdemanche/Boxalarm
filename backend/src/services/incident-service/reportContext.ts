import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import type { Incident } from './entity.js';
import { getDocumentClient, getIncidentRepository, getTableName } from './repository.js';
import { getNerisDeptSettings, type NerisDeptSettings } from './nerisSettings.js';
import { queryIncidentResponseUnits } from './dispatchProjection.js';
import { createSchemaVersionRepository } from './schemaVersion/repository.js';
import { getCoreSchemaDocument } from './schemaVersion/s3Schema.js';
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
}

/**
 * The schema pin the report was authored under (same rule as updateIncident.ts), falling
 * back to ACTIVE; undefined when none is published or no bucket is configured, in which case
 * only the structural and department rules run.
 */
async function loadSchema(incident: Incident): Promise<NerisSchemaDocument | undefined> {
  const bucket = process.env.NERIS_SCHEMA_BUCKET_NAME;
  if (!bucket) {
    return undefined;
  }
  const repository = createSchemaVersionRepository(getDocumentClient(), getTableName(process.env));
  const pinned =
    (await repository.getSchemaVersion(incident.nerisSchemaVersion)) ??
    (await repository.getActiveSchemaVersion());
  return pinned ? getCoreSchemaDocument(getS3Client(), bucket, pinned.coreSchemaS3Key) : undefined;
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
  const [settings, units, schema] = await Promise.all([
    getNerisDeptSettings(client, tableName, deptId),
    queryIncidentResponseUnits(client, tableName, deptId, incidentId),
    loadSchema(incident),
  ]);
  return {
    incident,
    settings,
    units: units as unknown as ResponseUnitRow[],
    ...(schema ? { schema } : {}),
  };
}

/** Lazily built so a local-only check never reads NERIS credentials. */
export async function nerisApiFromEnv(): Promise<NerisApi> {
  return createNerisApi(getNerisClient(await readNerisConfig(process.env)));
}
