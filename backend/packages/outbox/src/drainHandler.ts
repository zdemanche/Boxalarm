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

const METRIC_NAMESPACE = 'Boxalarm/outbox-publisher';
const EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE = 10;

export interface OutboxDrainConfig {
  readonly eventBusName: string;
  readonly tableName: string;
}

export function readOutboxDrainConfig(env: NodeJS.ProcessEnv): OutboxDrainConfig {
  const eventBusName = env.PLATFORM_EVENT_BUS_NAME;
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!eventBusName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
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
): OutboxDrainClients {
  readOutboxDrainConfig(env);
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

function toOutboxStreamRecord(
  value: Record<string, unknown>,
  sequenceNumber: string,
): OutboxStreamRecord | undefined {
  if (
    value.entityType !== 'OUTBOX_ENTRY' ||
    typeof value.pk !== 'string' ||
    typeof value.sk !== 'string' ||
    typeof value.eventId !== 'string' ||
    typeof value.eventTime !== 'string' ||
    typeof value.eventType !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.correlationId !== 'string' ||
    typeof value.schemaVersion !== 'string' ||
    typeof value.payload !== 'object' ||
    value.payload === null
  ) {
    return undefined;
  }
  return {
    pk: value.pk,
    sk: value.sk,
    eventId: value.eventId,
    eventTime: value.eventTime,
    eventType: value.eventType,
    source: value.source,
    correlationId: value.correlationId,
    schemaVersion: value.schemaVersion,
    payload: value.payload as Record<string, unknown>,
    sequenceNumber,
  };
}

function parseOutboxRecord(record: DynamoDBRecord): OutboxStreamRecord | undefined {
  const newImage = record.dynamodb?.NewImage;
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  if (record.eventName !== 'INSERT' || !newImage || !sequenceNumber) {
    return undefined;
  }
  const item = unmarshall(newImage as unknown as Record<string, AttributeValue>);
  return toOutboxStreamRecord(item, sequenceNumber);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function markSent(
  ddbClient: DynamoDBDocumentClient,
  tableName: string,
  record: OutboxStreamRecord,
  logger: Logger,
): Promise<void> {
  try {
    await ddbClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: record.pk, sk: record.sk },
        UpdateExpression: 'SET sentAt = :now',
        // Writers set sentAt: null at insert time (a present NULL-typed attribute,
        // not an absent one), so attribute_not_exists(sentAt) alone would never match.
        ConditionExpression: 'attribute_not_exists(sentAt) OR sentAt = :null',
        ExpressionAttributeValues: { ':now': Date.now(), ':null': null },
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'Published');
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    logger.error({
      event: 'outbox.mark_sent_failed',
      correlationId: record.correlationId,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'MarkSentFailed');
  }
}

async function publishOutboxBatch(
  clients: OutboxDrainClients,
  config: OutboxDrainConfig,
  logger: Logger,
  records: readonly OutboxStreamRecord[],
): Promise<string | undefined> {
  let response;
  try {
    response = await clients.eventBridgeClient.send(
      new PutEventsCommand({
        Entries: records.map((record) => ({
          EventBusName: config.eventBusName,
          Source: record.source,
          DetailType: record.eventType,
          Detail: JSON.stringify({
            eventId: record.eventId,
            eventTime: record.eventTime,
            eventType: record.eventType,
            source: record.source,
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
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'EventBridgeUnavailable');
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
      emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'EventBridgeEntryError');
      firstFailedSequenceNumber ??= record.sequenceNumber;
      continue;
    }
    await markSent(clients.ddbClient, config.tableName, record, logger);
  }
  return firstFailedSequenceNumber;
}

export function createOutboxDrainHandler(
  serviceName: string,
  overrides: Partial<OutboxDrainClients> = {},
): Handler<DynamoDBStreamEvent, DynamoDBBatchResponse> {
  const logger = createLogger({ service: serviceName });
  return async (event) => {
    const config = readOutboxDrainConfig(process.env);
    const clients = createOutboxDrainClients(process.env, overrides);
    const outboxRecords = event.Records.map(parseOutboxRecord).filter(
      (record): record is OutboxStreamRecord => record !== undefined,
    );
    for (const batch of chunk(outboxRecords, EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE)) {
      const failedSequenceNumber = await publishOutboxBatch(clients, config, logger, batch);
      if (failedSequenceNumber) {
        return { batchItemFailures: [{ itemIdentifier: failedSequenceNumber }] };
      }
    }
    return { batchItemFailures: [] };
  };
}
