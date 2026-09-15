import type { AttributeValue, DynamoDBStreamEvent, Handler } from 'aws-lambda';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { readOutboxPublisherConfig, type OutboxPublisherConfig } from '../config.js';

const MAX_ENTRIES_PER_PUT_EVENTS = 10;

interface OutboxDeps {
  readonly docClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
}

interface ParsedOutboxEntry {
  readonly deptId: string;
  readonly memberId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventTime: string;
  readonly source: string;
  readonly correlationId: string;
  readonly schemaVersion: string;
  readonly payload: Record<string, string>;
}

function unmarshalStringMap(value: AttributeValue | undefined): Record<string, string> {
  if (!value?.M) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, attribute] of Object.entries(value.M)) {
    if (typeof attribute.S === 'string') {
      result[key] = attribute.S;
    }
  }
  return result;
}

function parseOutboxEntry(image: Record<string, AttributeValue>): ParsedOutboxEntry {
  const deptId = image.deptId?.S;
  const memberId = image.memberId?.S;
  const eventId = image.eventId?.S;
  const eventType = image.eventType?.S;
  const eventTime = image.eventTime?.S;
  const source = image.source?.S;
  const correlationId = image.correlationId?.S;
  const schemaVersion = image.schemaVersion?.S;

  if (
    !deptId ||
    !memberId ||
    !eventId ||
    !eventType ||
    !eventTime ||
    !source ||
    !correlationId ||
    !schemaVersion
  ) {
    console.error(
      JSON.stringify({
        event: 'personnel.outbox.publish.malformed',
        service: 'personnel-service',
        correlationId: eventId ?? 'unknown',
      }),
    );
    throw new Error('Outbox stream record is missing a required envelope field');
  }

  return {
    deptId,
    memberId,
    eventId,
    eventType,
    eventTime,
    source,
    correlationId,
    schemaVersion,
    payload: unmarshalStringMap(image.payload),
  };
}

function emitOutboxMetric(
  outcome: 'OutboxEntryPublished' | 'OutboxEntryPublishFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Personnel',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

let cachedDocClient: DynamoDBDocumentClient | undefined;
let cachedEventBridgeClient: EventBridgeClient | undefined;

function getDocClient(client?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  cachedDocClient ??= client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return cachedDocClient;
}

function getEventBridgeClient(client?: EventBridgeClient): EventBridgeClient {
  cachedEventBridgeClient ??= client ?? new EventBridgeClient({});
  return cachedEventBridgeClient;
}

async function markSent(
  entry: ParsedOutboxEntry,
  docClient: DynamoDBDocumentClient,
  config: OutboxPublisherConfig,
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: {
          pk: buildDeptScopedPk(
            toVerifiedDeptId({ deptId: entry.deptId }),
            'OUTBOX',
            entry.memberId,
          ),
          sk: `EVT#${entry.eventId}`,
        },
        ConditionExpression: 'attribute_not_exists(sentAt)',
        UpdateExpression: 'SET sentAt = :now',
        ExpressionAttributeValues: { ':now': Date.now() },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return;
    }
    console.error(
      JSON.stringify({
        event: 'personnel.outbox.markSent.failed',
        service: 'personnel-service',
        correlationId: entry.correlationId,
        memberId: entry.memberId,
        eventId: entry.eventId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitOutboxMetric(
      'OutboxEntryPublishFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
}

async function publishBatch(
  images: Record<string, AttributeValue>[],
  deps: OutboxDeps,
): Promise<void> {
  const config = readOutboxPublisherConfig(process.env);
  const eventBridgeClient = getEventBridgeClient(deps.eventBridgeClient);
  const docClient = getDocClient(deps.docClient);
  const entries = images.map(parseOutboxEntry);

  let response;
  try {
    response = await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: entries.map((entry) => ({
          EventBusName: config.busName,
          Source: entry.source,
          DetailType: entry.eventType,
          Detail: JSON.stringify({
            eventId: entry.eventId,
            eventTime: entry.eventTime,
            eventType: entry.eventType,
            source: entry.source,
            correlationId: entry.correlationId,
            schemaVersion: entry.schemaVersion,
            payload: entry.payload,
          }),
        })),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'personnel.outbox.publish.failed',
        service: 'personnel-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitOutboxMetric(
      'OutboxEntryPublishFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }

  const failedIndexes = new Set<number>();
  if ((response.FailedEntryCount ?? 0) > 0) {
    response.Entries?.forEach((resultEntry, index) => {
      if (!resultEntry.ErrorCode) {
        return;
      }
      failedIndexes.add(index);
      const entry = entries[index];
      console.error(
        JSON.stringify({
          event: 'personnel.outbox.publish.entryFailed',
          service: 'personnel-service',
          correlationId: entry?.correlationId,
          memberId: entry?.memberId,
          eventId: entry?.eventId,
          reason: resultEntry.ErrorCode,
          message: resultEntry.ErrorMessage,
        }),
      );
    });
    emitOutboxMetric('OutboxEntryPublishFailed', 'PartialFailure');
  }

  const succeeded = entries.filter((_, index) => !failedIndexes.has(index));
  await Promise.all(succeeded.map((entry) => markSent(entry, docClient, config)));
  succeeded.forEach(() => emitOutboxMetric('OutboxEntryPublished'));

  if (failedIndexes.size > 0) {
    throw new Error(
      `EventBridge PutEvents reported ${failedIndexes.size} of ${entries.length} entries failed`,
    );
  }
}

export function createHandler(deps: OutboxDeps = {}): Handler<DynamoDBStreamEvent, void> {
  return async (event) => {
    const images = event.Records.filter((record) => record.eventName === 'INSERT')
      .map((record) => record.dynamodb?.NewImage)
      .filter(
        (image): image is Record<string, AttributeValue> =>
          !!image && image.entityType?.S === 'OUTBOX_ENTRY' && !image.sentAt,
      );

    for (let i = 0; i < images.length; i += MAX_ENTRIES_PER_PUT_EVENTS) {
      await publishBatch(images.slice(i, i + MAX_ENTRIES_PER_PUT_EVENTS), deps);
    }
  };
}

export const handler = createHandler();
