import type { Handler, ScheduledEvent } from 'aws-lambda';
import type { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocumentClient, getTableName } from '../../repository.js';
import { getS3Client } from '../../../platform-service/export/awsClients.js';
import { putSchemaDocument } from '../s3Schema.js';
import { createSchemaVersionRepository, DuplicateSchemaVersionError } from '../repository.js';
import type { NerisSchemaDocument, NerisSecondarySchemaDocument } from '../entity.js';

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
  const ddb = deps.dynamoClient ?? getDocumentClient();
  const s3 = deps.s3Client ?? getS3Client();
  const now = deps.now ?? Date.now;
  const repository = createSchemaVersionRepository(ddb, tableName);

  try {
    const feed = await fetchUpstreamSchemaFeed(sourceUrl, deps.fetchFn ?? fetch);
    const coreKey = `neris-schema/${feed.version}/core.json`;
    const secondaryKey = `neris-schema/${feed.version}/secondary.json`;

    await Promise.all([
      putSchemaDocument(s3, bucket, coreKey, feed.core),
      putSchemaDocument(s3, bucket, secondaryKey, feed.secondary),
    ]);

    await repository.publishSchemaVersion({
      version: feed.version,
      coreSchemaS3Key: coreKey,
      secondarySchemaS3Key: secondaryKey,
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
