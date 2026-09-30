import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import xray from 'aws-xray-sdk-core';
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
  Handler,
} from 'aws-lambda';
import { createLogger, type Logger } from '@boxalarm/logging';
import { emitOutcomeMetric } from '@boxalarm/metrics';

const DEFAULT_METRIC_NAMESPACE = 'Boxalarm/outbox-publisher';
const DEFAULT_TABLE_NAME_ENV_VAR = 'PLATFORM_TABLE_NAME';
const EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE = 10;

export interface OutboxDrainOptions {
  /** Env var naming the table whose outbox rows get marked sentAt. Default PLATFORM_TABLE_NAME. */
  readonly tableNameEnvVar?: string;
  /**
   * When set, every event is published under this Source instead of the row's own
   * `source`, so a row can never claim another service's identity on the bus.
   */
  readonly source?: string;
  /**
   * When set, only these eventTypes leave the table. Anything else is skipped (never
   * retried, never marked sent), logged, and counted as EventTypeRejected — the drain
   * is an allow-listed, outward-only bridge rather than a pipe for every OUTBOX_ENTRY.
   */
  readonly allowedEventTypes?: ReadonlySet<string>;
  /** CloudWatch EMF namespace for the drain's outcome metrics. Default Boxalarm/outbox-publisher. */
  readonly metricNamespace?: string;
}

export interface OutboxDrainConfig {
  readonly eventBusName: string;
  readonly tableName: string;
}

export function readOutboxDrainConfig(
  env: NodeJS.ProcessEnv,
  tableNameEnvVar: string = DEFAULT_TABLE_NAME_ENV_VAR,
): OutboxDrainConfig {
  const eventBusName = env.PLATFORM_EVENT_BUS_NAME;
  const tableName = env[tableNameEnvVar];
  if (!eventBusName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  if (!tableName) {
    throw new Error(`${tableNameEnvVar} is required and was not set`);
  }
  return { eventBusName, tableName };
}

export interface OutboxDrainClients {
  readonly eventBridgeClient: EventBridgeClient;
  readonly ddbClient: DynamoDBDocumentClient;
}

let cachedEventBridgeClient: EventBridgeClient | undefined;
let cachedDdbClient: DynamoDBDocumentClient | undefined;

export function createOutboxDrainClients(
  env: NodeJS.ProcessEnv,
  overrides: Partial<OutboxDrainClients> = {},
  tableNameEnvVar: string = DEFAULT_TABLE_NAME_ENV_VAR,
): OutboxDrainClients {
  readOutboxDrainConfig(env, tableNameEnvVar);
  cachedEventBridgeClient ??=
    overrides.eventBridgeClient ?? xray.captureAWSv3Client(new EventBridgeClient({}));
  cachedDdbClient ??=
    overrides.ddbClient ??
    DynamoDBDocumentClient.from(xray.captureAWSv3Client(new DynamoDBClient({})));
  return { eventBridgeClient: cachedEventBridgeClient, ddbClient: cachedDdbClient };
}

interface OutboxStreamRecord {
  readonly pk: string;
  readonly sk: string;
  readonly eventId: string;
  readonly eventTime: string;
  readonly eventType: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: Record<string, unknown>;
  readonly sequenceNumber: string;
}

/**
 * The string fields every OUTBOX_ENTRY row must carry to be published (besides an object
 * `payload`). Exported so the writers' contract test (src/services/outboxEnvelope.contract.test.ts)
 * checks exactly what the drain requires.
 */
export const OUTBOX_ENVELOPE_FIELDS = [
  'pk',
  'sk',
  'eventId',
  'eventTime',
  'eventType',
  'source',
  'correlationId',
  'schemaVersion',
] as const;

/** The envelope fields an OUTBOX_ENTRY row lacks (empty when the drain can publish it). */
export function missingOutboxEnvelopeFields(value: Record<string, unknown>): string[] {
  const missing: string[] = OUTBOX_ENVELOPE_FIELDS.filter(
    (field) => typeof value[field] !== 'string',
  );
  if (typeof value.payload !== 'object' || value.payload === null) {
    missing.push('payload');
  }
  return missing;
}

function toOutboxStreamRecord(
  value: Record<string, unknown>,
  sequenceNumber: string,
): OutboxStreamRecord | undefined {
  if (value.entityType !== 'OUTBOX_ENTRY' || missingOutboxEnvelopeFields(value).length > 0) {
    return undefined;
  }
  const row = value as Record<(typeof OUTBOX_ENVELOPE_FIELDS)[number], string>;
  return {
    pk: row.pk,
    sk: row.sk,
    eventId: row.eventId,
    eventTime: row.eventTime,
    eventType: row.eventType,
    source: row.source,
    correlationId: row.correlationId,
    schemaVersion: row.schemaVersion,
    payload: value.payload as Record<string, unknown>,
    sequenceNumber,
  };
}

/**
 * An OUTBOX_ENTRY INSERT the drain cannot publish is never retried (it can never succeed) - but
 * it is a lost domain event: availability mark-offs were dropped exactly like this, silently
 * (post-merge). Logged with the missing fields and counted as MalformedOutboxRow so it pages.
 */
function parseOutboxRecord(
  record: DynamoDBRecord,
  logger: Logger,
  metricNamespace: string,
): OutboxStreamRecord | undefined {
  const newImage = record.dynamodb?.NewImage;
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  if (record.eventName !== 'INSERT' || !newImage || !sequenceNumber) {
    return undefined;
  }
  const item = unmarshall(newImage as unknown as Record<string, AttributeValue>);
  const parsed = toOutboxStreamRecord(item, sequenceNumber);
  if (!parsed && item.entityType === 'OUTBOX_ENTRY') {
    logger.error({
      event: 'outbox.malformed_row',
      correlationId: typeof item.correlationId === 'string' ? item.correlationId : 'unknown',
      reason: 'MissingEnvelopeFields',
      missing: missingOutboxEnvelopeFields(item),
      eventType: typeof item.eventType === 'string' ? item.eventType : undefined,
      eventId: typeof item.eventId === 'string' ? item.eventId : undefined,
    });
    emitOutcomeMetric(metricNamespace, 'MalformedOutboxRow', 'MissingEnvelopeFields');
  }
  return parsed;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

interface DrainContext {
  readonly clients: OutboxDrainClients;
  readonly config: OutboxDrainConfig;
  readonly logger: Logger;
  readonly metricNamespace: string;
  readonly source: string | undefined;
}

async function markSent(context: DrainContext, record: OutboxStreamRecord): Promise<void> {
  const { clients, config, logger, metricNamespace } = context;
  try {
    await clients.ddbClient.send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: { pk: record.pk, sk: record.sk },
        UpdateExpression: 'SET sentAt = :now',
        // Writers set sentAt: null at insert time (a present NULL-typed attribute,
        // not an absent one), so attribute_not_exists(sentAt) alone would never match.
        ConditionExpression: 'attribute_not_exists(sentAt) OR sentAt = :null',
        ExpressionAttributeValues: { ':now': Date.now(), ':null': null },
      }),
    );
    emitOutcomeMetric(metricNamespace, 'Published');
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    logger.error({
      event: 'outbox.mark_sent_failed',
      correlationId: record.correlationId,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    });
    emitOutcomeMetric(metricNamespace, 'MarkSentFailed');
  }
}

async function publishOutboxBatch(
  context: DrainContext,
  records: readonly OutboxStreamRecord[],
): Promise<string | undefined> {
  const { clients, config, logger, metricNamespace } = context;
  let response;
  try {
    response = await clients.eventBridgeClient.send(
      new PutEventsCommand({
        Entries: records.map((record) => ({
          EventBusName: config.eventBusName,
          Source: context.source ?? record.source,
          DetailType: record.eventType,
          Detail: JSON.stringify({
            eventId: record.eventId,
            eventTime: record.eventTime,
            eventType: record.eventType,
            source: context.source ?? record.source,
            correlationId: record.correlationId,
            schemaVersion: record.schemaVersion,
            payload: record.payload,
          }),
        })),
      }),
    );
  } catch (error) {
    logger.error({
      event: 'outbox.publish_failed',
      correlationId: records[0]?.correlationId ?? 'unknown',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      eventTypes: records.map((record) => record.eventType),
      eventIds: records.map((record) => record.eventId),
    });
    emitOutcomeMetric(metricNamespace, 'PublishFailed', 'EventBridgeUnavailable');
    return records[0]?.sequenceNumber;
  }

  let firstFailedSequenceNumber: string | undefined;
  const entries = response.Entries ?? [];
  for (const [index, entry] of entries.entries()) {
    const record = records[index];
    if (!record) {
      continue;
    }
    if (entry.ErrorCode) {
      logger.error({
        event: 'outbox.publish_entry_failed',
        correlationId: record.correlationId,
        reason: entry.ErrorCode,
      });
      emitOutcomeMetric(metricNamespace, 'PublishFailed', 'EventBridgeEntryError');
      firstFailedSequenceNumber ??= record.sequenceNumber;
      continue;
    }
    await markSent(context, record);
  }
  return firstFailedSequenceNumber;
}

function isAllowed(
  record: OutboxStreamRecord,
  options: OutboxDrainOptions,
  logger: Logger,
  metricNamespace: string,
): boolean {
  if (!options.allowedEventTypes || options.allowedEventTypes.has(record.eventType)) {
    return true;
  }
  logger.error({
    event: 'outbox.event_type_rejected',
    correlationId: record.correlationId,
    reason: 'NotAllowListed',
    eventType: record.eventType,
    eventId: record.eventId,
  });
  emitOutcomeMetric(metricNamespace, 'EventTypeRejected', 'NotAllowListed');
  return false;
}

export function createOutboxDrainHandler(
  serviceName: string,
  overrides: Partial<OutboxDrainClients> = {},
  options: OutboxDrainOptions = {},
): Handler<DynamoDBStreamEvent, DynamoDBBatchResponse> {
  const logger = createLogger({ service: serviceName });
  const tableNameEnvVar = options.tableNameEnvVar ?? DEFAULT_TABLE_NAME_ENV_VAR;
  const metricNamespace = options.metricNamespace ?? DEFAULT_METRIC_NAMESPACE;
  return async (event) => {
    const config = readOutboxDrainConfig(process.env, tableNameEnvVar);
    const clients = createOutboxDrainClients(process.env, overrides, tableNameEnvVar);
    const context: DrainContext = {
      clients,
      config,
      logger,
      metricNamespace,
      source: options.source,
    };
    const outboxRecords = event.Records.map((record) =>
      parseOutboxRecord(record, logger, metricNamespace),
    ).filter(
      (record): record is OutboxStreamRecord =>
        record !== undefined && isAllowed(record, options, logger, metricNamespace),
    );
    for (const batch of chunk(outboxRecords, EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE)) {
      const failedSequenceNumber = await publishOutboxBatch(context, batch);
      if (failedSequenceNumber) {
        return { batchItemFailures: [{ itemIdentifier: failedSequenceNumber }] };
      }
    }
    return { batchItemFailures: [] };
  };
}
