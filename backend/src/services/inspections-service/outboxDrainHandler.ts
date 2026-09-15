import xray from 'aws-xray-sdk-core';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
  Handler,
} from 'aws-lambda';
import { logError } from './logger.js';

export interface EventBusConfig {
  readonly eventBusName: string;
}

export function readEventBusConfig(env: NodeJS.ProcessEnv): EventBusConfig {
  const eventBusName = env.PLATFORM_EVENT_BUS_NAME;
  if (!eventBusName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  return { eventBusName };
}

let cachedClient: EventBridgeClient | undefined;

export function createEventBridgeClient(
  env: NodeJS.ProcessEnv,
  client?: EventBridgeClient,
): EventBridgeClient {
  readEventBusConfig(env);
  cachedClient ??= client ?? xray.captureAWSv3Client(new EventBridgeClient({}));
  return cachedClient;
}

interface OutboxStreamRecord {
  readonly entityType: 'OUTBOX_RECORD';
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
    value.entityType !== 'OUTBOX_RECORD' ||
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
    entityType: 'OUTBOX_RECORD',
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

const EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE = 10;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function publishOutboxBatch(
  client: EventBridgeClient,
  eventBusName: string,
  records: readonly OutboxStreamRecord[],
): Promise<void> {
  try {
    const response = await client.send(
      new PutEventsCommand({
        Entries: records.map((record) => ({
          EventBusName: eventBusName,
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
    if ((response.FailedEntryCount ?? 0) > 0) {
      const failures = response.Entries?.filter((entry) => entry.ErrorCode).map((entry) => ({
        errorCode: entry.ErrorCode,
        errorMessage: entry.ErrorMessage,
      }));
      throw new Error(
        `EventBridge PutEvents reported ${response.FailedEntryCount} failed entries: ${JSON.stringify(failures)}`,
      );
    }
  } catch (error) {
    logError({
      event: 'outbox.publish_failed',
      service: 'inspections-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      eventTypes: records.map((record) => record.eventType),
      eventIds: records.map((record) => record.eventId),
    });
    throw error;
  }
}

export function createOutboxDrainHandler(
  client?: EventBridgeClient,
): Handler<DynamoDBStreamEvent, DynamoDBBatchResponse> {
  return async (event) => {
    const eventBusName = readEventBusConfig(process.env).eventBusName;
    const bridgeClient = createEventBridgeClient(process.env, client);
    const outboxRecords = event.Records.map(parseOutboxRecord).filter(
      (record): record is OutboxStreamRecord => record !== undefined,
    );
    for (const batch of chunk(outboxRecords, EVENTBRIDGE_PUT_EVENTS_BATCH_SIZE)) {
      try {
        await publishOutboxBatch(bridgeClient, eventBusName, batch);
      } catch {
        return { batchItemFailures: [{ itemIdentifier: batch[0]!.sequenceNumber }] };
      }
    }
    return { batchItemFailures: [] };
  };
}

export const handler = createOutboxDrainHandler();
