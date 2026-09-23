import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { createDdbClient, readPersonnelDdbConfig } from '../availability/dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-outbox';
const PUT_EVENTS_BATCH_SIZE = 10;

interface EventBridgeConfig {
  readonly busName: string;
}

function readEventBridgeConfig(env: NodeJS.ProcessEnv): EventBridgeConfig {
  const busName = env.PLATFORM_EVENT_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  return { busName };
}

let cachedClient: EventBridgeClient | undefined;

export function createEventBridgeClient(
  env: NodeJS.ProcessEnv,
  client?: EventBridgeClient,
): EventBridgeClient {
  readEventBridgeConfig(env);
  cachedClient ??= client ?? AWSXRay.captureAWSv3Client(new EventBridgeClient({}));
  return cachedClient;
}

function unmarshalNewImage(image: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, attr] of Object.entries(image ?? {})) {
    const value = attr as { S?: string; N?: string; BOOL?: boolean; M?: Record<string, unknown> };
    if (value.S !== undefined) out[key] = value.S;
    else if (value.N !== undefined) out[key] = Number(value.N);
    else if (value.BOOL !== undefined) out[key] = value.BOOL;
    else if (value.M !== undefined) out[key] = unmarshalNewImage(value.M);
  }
  return out;
}

function logError(event: string, error: unknown, correlationId: string): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
    }),
  );
}

export interface PublisherDeps {
  readonly eventBridgeClient?: EventBridgeClient;
}

interface PendingOutboxEntry {
  readonly item: Record<string, unknown>;
  readonly correlationId: string;
}

function eventTimeIso(item: Record<string, unknown>): string {
  if (typeof item.eventTime === 'string') {
    return item.eventTime;
  }
  const createdAt = item.createdAt;
  return typeof createdAt === 'number'
    ? new Date(createdAt * 1000).toISOString()
    : new Date().toISOString();
}

export const handler = async (
  streamEvent: DynamoDBStreamEvent,
  deps: PublisherDeps = {},
): Promise<void> => {
  const { busName } = readEventBridgeConfig(process.env);
  const { tableName } = readPersonnelDdbConfig(process.env);
  const eb = createEventBridgeClient(process.env, deps.eventBridgeClient);
  const ddb = createDdbClient(process.env);

  const pending: PendingOutboxEntry[] = [];
  for (const record of streamEvent.Records) {
    if (record.eventName !== 'INSERT') {
      continue;
    }
    const item = unmarshalNewImage(record.dynamodb?.NewImage);
    if (item.entityType !== 'OUTBOX_ENTRY' || item.sentAt !== undefined) {
      continue;
    }
    const correlationId = typeof item.correlationId === 'string' ? item.correlationId : 'unknown';
    pending.push({ item, correlationId });
  }

  for (let offset = 0; offset < pending.length; offset += PUT_EVENTS_BATCH_SIZE) {
    const chunk = pending.slice(offset, offset + PUT_EVENTS_BATCH_SIZE);
    const chunkCorrelationId = chunk.map((entry) => entry.correlationId).join(',');

    let response;
    try {
      response = await eb.send(
        new PutEventsCommand({
          Entries: chunk.map(({ item, correlationId }) => ({
            Source: 'personnel-service',
            DetailType: String(item.eventType),
            EventBusName: busName,
            Detail: JSON.stringify({
              eventId: item.eventId,
              eventTime: eventTimeIso(item),
              eventType: item.eventType,
              source: 'personnel-service',
              correlationId,
              schemaVersion: '1.0',
              payload: item.payload,
            }),
          })),
        }),
      );
    } catch (error) {
      logError('outbox.publish_failed', error, chunkCorrelationId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'EventBridgeUnavailable');
      throw error;
    }

    for (const [index, result] of (response.Entries ?? []).entries()) {
      const entry = chunk[index];
      if (!entry) {
        continue;
      }
      const { item, correlationId } = entry;
      if (result.ErrorCode) {
        logError(
          'outbox.publish_entry_failed',
          new Error(result.ErrorMessage ?? result.ErrorCode),
          correlationId,
        );
        emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', 'EventBridgeEntryError');
        continue;
      }

      const { pk, sk } = item;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk, sk },
            UpdateExpression: 'SET sentAt = :now',
            // Writers set sentAt: null at insert time (a present NULL-typed attribute,
            // not an absent one), so attribute_not_exists(sentAt) alone would always be
            // false for them — this item would never actually get marked sent.
            ConditionExpression: 'attribute_not_exists(sentAt) OR sentAt = :null',
            ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000), ':null': null },
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          continue;
        }
        logError('outbox.mark_sent_failed', error, correlationId);
        throw error;
      }

      emitOutcomeMetric(METRIC_NAMESPACE, 'Published');
    }
  }
};
