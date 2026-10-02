import type { Handler, ScheduledEvent } from 'aws-lambda';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from '../../repository.js';
import { getS3Client } from '../../../platform-service/export/awsClients.js';
import { putSchemaDocument } from '../s3Schema.js';
import { createSchemaVersionRepository, DuplicateSchemaVersionError } from '../repository.js';
import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from '../entity.js';
import { compileNerisSchema, type CompiledNerisSchema } from '../../neris/apiSchema.js';

const METRIC_NAMESPACE = 'Boxalarm/neris-schema-version-refresh';

interface UpstreamSchemaFeed {
  readonly version: string;
  readonly core: NerisSchemaDocument;
  readonly secondary: NerisSecondarySchemaDocument;
}

function readSourceUrl(env: NodeJS.ProcessEnv): string {
  const url = env.NERIS_SCHEMA_SOURCE_URL;
  if (!url) {
    throw new Error('NERIS_SCHEMA_SOURCE_URL is required and was not set');
  }
  return url;
}

function readBucketName(env: NodeJS.ProcessEnv): string {
  const bucket = env.NERIS_SCHEMA_BUCKET_NAME;
  if (!bucket) {
    throw new Error('NERIS_SCHEMA_BUCKET_NAME is required and was not set');
  }
  return bucket;
}

// The upstream neris-framework repo (github.com/ulfsri/neris-framework) publishes its
// Core/Secondary enumerations as XLSX/YAML/CSV; a separate offline conversion pipeline
// (not part of this Lambda) normalizes those into the JSON shape fetched here, so this
// scanner never depends on an XLSX/YAML parsing library at runtime.
export async function fetchUpstreamSchemaFeed(
  sourceUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<UpstreamSchemaFeed> {
  const response = await fetchFn(sourceUrl);
  if (!response.ok) {
    throw new Error(`NERIS schema source returned ${response.status}`);
  }
  const feed = (await response.json()) as Partial<UpstreamSchemaFeed>;
  if (!feed.version || !feed.core || !feed.secondary) {
    throw new Error('NERIS schema source feed failed shape validation');
  }
  return feed as UpstreamSchemaFeed;
}

/**
 * The NERIS OpenAPI document of this environment's NERIS host (public; the WAF wants a
 * User-Agent). Compiled into the payload schema that the picker, local validation and the
 * payload builder all read, so the incident-type list is never hand-copied.
 */
export async function fetchNerisApiSchema(
  url: string,
  userAgent: string,
  fetchFn: typeof fetch = fetch,
): Promise<CompiledNerisSchema> {
  const response = await fetchFn(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) {
    throw new Error(`NERIS OpenAPI document returned ${response.status}`);
  }
  return compileNerisSchema(await response.json());
}

function readOpenApiSource(env: NodeJS.ProcessEnv): { url: string; userAgent: string } {
  const url = env.NERIS_OPENAPI_URL;
  const userAgent = env.NERIS_USER_AGENT;
  if (!url || !userAgent) {
    throw new Error('NERIS_OPENAPI_URL and NERIS_USER_AGENT are required and were not set');
  }
  return { url, userAgent };
}

export interface SchemaVersionRefreshDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly s3Client?: S3Client;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export async function runSchemaVersionRefresh(
  correlationId: string,
  deps: SchemaVersionRefreshDeps = {},
): Promise<void> {
  const tableName = getTableName(process.env);
  const bucket = readBucketName(process.env);
  const sourceUrl = readSourceUrl(process.env);
  const openApi = readOpenApiSource(process.env);
  const ddb = deps.dynamoClient ?? getDocumentClient();
  const s3 = deps.s3Client ?? getS3Client();
  const now = deps.now ?? Date.now;
  const repository = createSchemaVersionRepository(ddb, tableName);

  try {
    const [feed, nerisApi] = await Promise.all([
      fetchUpstreamSchemaFeed(sourceUrl, deps.fetchFn ?? fetch),
      fetchNerisApiSchema(openApi.url, openApi.userAgent, deps.fetchFn ?? fetch),
    ]);
    // One pin names both sources: a new NERIS API release publishes a new version even when
    // the framework feed is unchanged, and N-1 pins keep resolving.
    const version = `${feed.version}+neris-${nerisApi.apiVersion}`;
    const coreKey = `neris-schema/${version}/core.json`;
    const secondaryKey = `neris-schema/${version}/secondary.json`;
    const nerisApiKey = `neris-schema/${version}/neris-api.json`;
    // The incident-type list comes from the NERIS API itself (TypeIncidentValue), never
    // from the feed or a hand-kept copy.
    const core: NerisSchemaDocument = {
      ...feed.core,
      version,
      enumerations: { ...feed.core.enumerations, incident_type: nerisApi.incidentTypes },
    };

    await Promise.all([
      putSchemaDocument(s3, bucket, coreKey, core),
      putSchemaDocument(s3, bucket, secondaryKey, { ...feed.secondary, version }),
      putSchemaDocument(s3, bucket, nerisApiKey, nerisApi),
    ]);

    await repository.publishSchemaVersion({
      version,
      coreSchemaS3Key: coreKey,
      secondarySchemaS3Key: secondaryKey,
      nerisApiS3Key: nerisApiKey,
      publishedAt: now(),
    });

    emitOutcomeMetric(METRIC_NAMESPACE, 'SchemaVersionPublished');
  } catch (error) {
    if (error instanceof DuplicateSchemaVersionError) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'SchemaVersionUnchanged');
      return;
    }
    console.error(
      JSON.stringify({
        event: 'incident.schemaVersionRefresh.failed',
        service: 'incident-service',
        correlationId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'SchemaVersionRefreshFailed');
    throw error;
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runSchemaVersionRefresh(event.id);
};
